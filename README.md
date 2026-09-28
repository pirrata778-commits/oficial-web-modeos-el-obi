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
- Reloj y fecha local visibles en la interfaz.
- Imágenes de portada, Modelos y Directos administrables desde la Zona DEV y persistidas en PostgreSQL.
- Comandos DEV limitados en `/api/discord/commands`.
- Auditoría DEV en PostgreSQL mediante `/api/dev/security-logs`.
- Bloqueo de contraseña DEV tras cinco intentos fallidos.

No pongas tokens ni secretos dentro de `index.html`. Usa únicamente `.env`.
Las imágenes admitidas son PNG, JPEG y WebP, con un máximo de 2 MB cada una.

## Despliegue en Render

1. Crea un Web Service conectado a este repositorio o usa el archivo `render.yaml`.
2. Configura `PUBLIC_URL` con la URL HTTPS del servicio, por ejemplo `https://modeos-el-obi.onrender.com`.
3. Configura `FRONTEND_URL` con la URL de GitHub Pages, por ejemplo `https://usuario.github.io/repositorio`.
4. En GitHub Pages, la web usa por defecto `https://modeos-el-obi.onrender.com`, según el nombre del servicio en `render.yaml`. Si configuraste otro dominio para Render, ponlo en `<meta name="api-base-url" content="https://TU-DOMINIO">` dentro de `index.html`. Si sirves el frontend desde el mismo servicio Render, la API usa automáticamente el mismo origen.
5. En Discord Developer Portal añade como redirect URI:
   `https://modeos-el-obi.onrender.com/auth/discord/callback`
6. Completa en Render `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DEV_PASSWORD` y `DATABASE_URL` como variables secretas.
7. El servicio usa el puerto asignado por Render automáticamente. PostgreSQL se conecta mediante `DATABASE_URL`; no se necesita disco persistente para la base de datos.

La aplicación usa PostgreSQL en Neon para conservar los logs y los intentos de acceso al reiniciar o desplegar el servicio.
