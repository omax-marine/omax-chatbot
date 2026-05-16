# ⚓ OMAX MARINE — Chatbot Expert Nautique

Backend API pour le chatbot expert nautique d'OMAX MARINE, distributeur officiel Osculati France.

## Déploiement sur Render

1. Connecter ce repo à [Render](https://render.com)
2. Créer un **Web Service**
3. Ajouter la variable d'environnement `ANTHROPIC_API_KEY`
4. Déployer !

## Variables d'environnement

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Clé API Anthropic (obligatoire) |
| `PORT` | Port du serveur (défaut: 3456) |
| `ALLOWED_ORIGINS` | Domaines autorisés CORS |
| `RATE_LIMIT_PER_MINUTE` | Limite requêtes/min/IP (défaut: 10) |
