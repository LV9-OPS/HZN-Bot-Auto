# HZN Bot Auto v3

Bot de trading crypto qui détecte les débuts de mouvement (« early momentum ») via l'API de l'exchange **Revolut X**. Il a été entièrement reconstruit en octobre 2026.
**Le mode paper (simulation) est activé par défaut.** Le trading réel exige une activation explicite et documentée
([docs/GO_LIVE_CHECKLIST.md](docs/GO_LIVE_CHECKLIST.md)).

> Aucun profit n'est garanti. Pendant la reconstruction, la stratégie a été rejouée sur les données réelles de 7 jours (8–15 oct. 2026) puis de 21 jours.
> Sur ces périodes, le signal n'a **pas** couvert les frais, d'où la recommandation **NO-GO pour le live** (voir [docs/TEST_REPORT.md](docs/TEST_REPORT.md)).

## Nouveauté v4 : moteur de décision quantitatif (`ENTRY_MODE=quant`)

- **Cycle :** toutes les 15 minutes, le bot analyse des bougies d'1 heure.
- **Régime de marché :** il détecte la tendance, la volatilité, le manque de liquidité et les mouvements extrêmes. Il suit aussi la tendance de BTC.
- **Stratégies candidates :** `trend`, `breakout` et `pullback`. Chaque décision est expliquée et enregistrée dans `data/decisions.<mode>.jsonl`.
- **Risque :** au plus 1 % du capital par trade, avec un stop calé sur la volatilité (ATR). S'y ajoutent une limite mensuelle de −3 % (le bot vend tout et ne rachète plus jusqu'au mois suivant), un arrêt des achats à −10 % depuis le plus haut, une pause après plusieurs pertes d'affilée et un filtre de corrélation.
- **Validation :** `npm run research` teste les stratégies sur 2017–2026 par walk-forward (réglage sur 12 mois, test sur les 3 mois suivants, puis on décale). **Seule une stratégie validée peut trader en réel. Aujourd'hui, aucune ne l'est** (voir [docs/RESEARCH_2016_2026.md](docs/RESEARCH_2016_2026.md)).

## Ce que fait le bot

1. **Radar (toutes les ~5 s) :** une seule requête de prix pour tout le marché. Le bot filtre les paires `*-USDC` actives selon le spread et la liquidité,
   puis suit les variations sur 1, 3 et 5 minutes à partir de relevés gardés en mémoire.
2. **Analyse du début de mouvement :** le bot lit les bougies 1 minute du **marché de référence le plus liquide** de chaque crypto (USD ou EUR).
   Sur Revolut X, les carnets d'ordres USDC sont trop peu actifs : la plupart de leurs bougies n'ont aucun volume. Les cryptos signalées par le radar sont analysées en premier,
   et toutes les autres sont quand même revues à tour de rôle.
3. **Classement explicable :** chaque crypto reçoit un score de 0 à 100 qui combine momentum, accélération, volume relatif, cassure de résistance (breakout), tendance, calme avant le mouvement
   et coûts, moins une pénalité si le mouvement est déjà trop avancé. Chaque rejet porte une raison nommée (`already_extended`, `false_breakout`, …).
4. **Confirmation avant l'achat, sur des données fraîches :** le bot vérifie l'âge du signal, la hausse du prix depuis le signal, le spread et la profondeur du carnet.
   Il vérifie aussi que le coût aller-retour reste petit devant la distance au stop-loss, que les minimums de l'exchange sont respectés et que la vente de protection pourra bien être passée.
   Les ordres sont des ordres limite IOC (exécutés immédiatement ou annulés) : aucun ordre ne reste en attente sur l'exchange.
5. **Capital :** plafond strict de 10 USDC, répartis en 3 slots de 5, 3 et 2 USDC. Au maximum 3 positions, une seule par crypto.
6. **Sorties (exactement comme demandé) :**
   - Slot 1 : quand le prix atteint **2× le prix d'entrée**, un plancher s'arme à 1× l'entrée. Le bot vend si le prix redescend à ce plancher.
   - Slots 2 et 3 : même principe avec un objectif à **3× l'entrée** et un plancher à 2×.
   - Avant l'objectif, un **stop-loss à −3 % sur le bid** (meilleur prix acheteur) s'applique.
7. **Réconciliation avec l'exchange** au démarrage puis chaque minute : le bot compare son état local aux soldes et aux ordres réels de Revolut X.
   Il s'appuie sur un registre des ordres écrit sur disque et, en cas de doute, bloque les nouveaux achats plutôt que de deviner.
8. **Discord :** les messages sont en français et indiquent toujours si un ordre est seulement *soumis* ou réellement *exécuté*.

## Limite critique : pas de stop-loss natif sur l'exchange

L'API Revolut X (`POST /1.0/orders`) n'accepte que les ordres `limit` et `market`. Les ordres conditionnels et TP/SL existent dans l'application Revolut X.
L'API peut les *lire* et les *annuler*, mais **ne peut pas les créer**. Le stop-loss et les sorties sur plancher sont donc **surveillés par le logiciel**.
**Si le PC se met en veille, si le bot plante ou si le réseau est coupé, plus rien ne protège les positions.** Le bot détecte en revanche les TP/SL que vous créez
vous-même dans l'application, et les affiche comme protection supplémentaire.

## Démarrage rapide (Windows, PowerShell)

```powershell
cd C:\Users\insan\HZN-Bot-Auto
npm test                      # 85 tests automatiques
npm run reconcile             # vue LECTURE SEULE : votre compte réel comparé à l'état local
npm start                     # mode paper dans cette fenêtre (Ctrl+C pour arrêter)
# ou en mode supervisé (redémarrage automatique après un plantage) :
powershell -ExecutionPolicy Bypass -File scripts\run-bot.ps1
npm run status                # positions, PnL, achats autorisés ou non, meilleurs candidats, usage API
# tableau de bord : http://127.0.0.1:8787/
npm run stop                  # arrêt propre
```

## Commandes

| Commande | Rôle |
|---|---|
| `npm start` | Lancer le bot (le mode vient de `.env`, paper par défaut) |
| `npm run status [-- --mode live]` | Afficher le dernier état du bot |
| `npm run stop` | Arrêt propre (le superviseur ne relance pas le bot) |
| `npm run emergency-on` / `emergency-off` | Bloquer / réautoriser les nouveaux achats (les positions ouvertes restent surveillées) |
| `npm run reconcile` | Simulation de réconciliation en lecture seule sur le compte réel |
| `npm run account` | Soldes valorisés et historique des ordres exécutés (lecture seule) |
| `npm run adopt -- XRP-USDC [--entry P] --yes` | Confier au bot une crypto déjà détenue |
| `npm run resolve -- XRP-USDC --closed --yes` | Marquer comme clôturée une position vendue en dehors du bot |
| `npm run fetch-history -- --days 7` | Télécharger l'historique en bougies 1 minute pour le rejeu |
| `npm run replay` | Rejouer la stratégie sur l'historique, sans utiliser de données futures, avec frais, spread et glissement de prix (slippage) |
| `npm test` / `npm run check` | Tests / vérification de la syntaxe |

## Documentation

Les documents ci-dessous sont en anglais.

- [Installation sous Windows](docs/INSTALL_WINDOWS.md)
- [Référence de configuration](docs/CONFIGURATION.md)
- [Stratégie](docs/STRATEGY.md)
- [Gestion du risque](docs/RISK.md)
- [Notifications Discord](docs/DISCORD.md)
- [Dépannage](docs/TROUBLESHOOTING.md)
- [Déploiement et récupération](docs/DEPLOYMENT_RECOVERY.md)
- [Checklist de passage en live](docs/GO_LIVE_CHECKLIST.md)
- [Audit de la v0.2 et conception](docs/AUDIT_AND_DESIGN.md)
- [Notes et limites de l'API Revolut X](docs/API_NOTES.md)
- [Rapport de tests](docs/TEST_REPORT.md)
- [Journal des modifications](CHANGELOG.md)

## Architecture

```
src/api/            client Revolut X (signature Ed25519), file d'attente centrale des requêtes, contrôle strict des réponses
src/market/         cache des données de marché, scanner en plusieurs étapes (radar + analyse détaillée)
src/signals/        indicateurs de début de mouvement (bougies clôturées uniquement) et score explicable
src/strategy/       plans de sortie X2/X3 et stop-loss, confirmation juste avant l'achat
src/risk/           budget, slots, limites journalières, délais avant de reprendre une même crypto, contrôle des achats
src/execution/      cycle de vie des ordres (sans doublon, retrouvés par client_order_id), exchanges réel et simulé
src/reconciliation/ comparaison entre l'exchange et l'état local, récupération des positions
src/storage/        sauvegarde de l'état sans risque de fichier tronqué, copies de secours, validation, registre des ordres
src/notifications/  Discord (file d'attente, anti-doublons, secrets masqués)
src/monitoring/     journaux avec rotation et secrets masqués, serveur d'état local, protection contre deux instances, statistiques
src/cli/            status, stop, reconcile, adopt, resolve
tools/              fetch-history, replay, rapport de compte, vérification de syntaxe
tests/              tests unitaires, d'intégration et de bout en bout en mode paper (node:test, sans dépendance)
```

Aucune bibliothèque externe n'est nécessaire. Il faut Node.js ≥ 20.12 (testé avec Node 24.21 sous Windows et Node 22 sous Linux).
