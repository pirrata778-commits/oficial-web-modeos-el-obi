# MODEOS EL OBI

## Arranque

1. Instala Node.js 20 o superior.
2. Ejecuta `npm install`.
3. Copia `.env.example` a `.env` y completa los valores.
4. En Discord Developer Portal configura como redirect URI:
   `http://localhost:3000/auth/discord/callback`
5. Invita el bot con los permisos e intents necesarios.
6. Ejecuta `npm start` y abre `http://localhost:3000`.

## Servicios incluidos

- OAuth de Discord en `/auth/discord`.
- Sesiones HTTP protegidas.
- Bot real conectado mediante `discord.js`.
- Logs del bot por Server-Sent Events en `/api/discord/logs`.
- Comandos DEV limitados en `/api/discord/commands`.
- Auditoría DEV en SQLite mediante `/api/dev/security-logs`.
- Bloqueo de contraseña DEV tras cinco intentos fallidos.

No pongas tokens ni secretos dentro de `index.html`. Usa únicamente `.env`.

## Despliegue en Render

1. Crea un Web Service conectado a este repositorio o usa el archivo `render.yaml`.
2. Configura `PUBLIC_URL` con la URL HTTPS del servicio, por ejemplo `https://modeos-el-obi.onrender.com`.
3. Configura `FRONTEND_URL` con la URL de GitHub Pages, por ejemplo `https://usuario.github.io/repositorio`.
4. En `index.html`, sustituye `https://TU-SERVICIO.onrender.com` por la URL real de tu backend Render.
5. En Discord Developer Portal añade como redirect URI:
   `https://modeos-el-obi.onrender.com/auth/discord/callback`
6. Completa en Render `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` y `DEV_PASSWORD` como variables secretas.
7. El servicio usa el puerto asignado por Render automáticamente.

El archivo `render.yaml` configura un disco persistente para SQLite. Sin disco persistente, los logs y la base de datos se perderán al reiniciar o desplegar el servicio.
