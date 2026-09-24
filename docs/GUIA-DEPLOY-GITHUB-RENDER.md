# MODEOS EL OBI
## Guía completa de estructura y despliegue

Esta aplicación usa dos servicios:

- GitHub Pages: publica el frontend estático (`index.html`).
- Render Web Service: ejecuta el backend, OAuth de Discord, bot, logs, terminal DEV y SQLite.

## 1. Estructura del repositorio

```text
paguina web/
├── index.html          # Frontend y panel visual
├── server.js           # Backend Express, OAuth y bot Discord
├── package.json        # Dependencias y comandos Node
├── render.yaml         # Configuración automática para Render
├── .env.example        # Plantilla de variables secretas
├── .gitignore          # Evita subir secretos y dependencias
├── README.md           # Resumen del proyecto
└── docs/
    └── GUIA-DEPLOY-GITHUB-RENDER.md
```

## 2. Crear el repositorio en GitHub

1. Crea un repositorio nuevo en GitHub.
2. Sube todos los archivos del proyecto.
3. No subas ningún archivo `.env` real.
4. No subas `node_modules`.
5. Usa la rama `main`.

## 3. Activar GitHub Pages

1. Abre el repositorio en GitHub.
2. Entra en `Settings`.
3. Selecciona `Pages`.
4. Elige `Deploy from a branch`.
5. Selecciona la rama `main`.
6. Selecciona la carpeta `/root`.
7. Guarda.

La URL tendrá este formato:

```text
https://TU_USUARIO.github.io/TU_REPOSITORIO/
```

Guarda esa URL porque será el valor de `FRONTEND_URL`.

## 4. Crear el servicio en Render

1. Entra en Render.
2. Selecciona `New` y después `Web Service`.
3. Conecta el repositorio de GitHub.
4. Usa esta configuración:

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
```

No uses `Static Site` para el backend.

El servicio generará una URL parecida a:

```text
https://TU-SERVICIO.onrender.com
```

## 5. Variables de entorno en Render

En Render, abre `Environment` y añade:

```env
NODE_ENV=production
PUBLIC_URL=https://TU-SERVICIO.onrender.com
FRONTEND_URL=https://TU_USUARIO.github.io/TU_REPOSITORIO
SESSION_SECRET=GENERA_UNA_CLAVE_LARGA_Y_ALEATORIA
DISCORD_CLIENT_ID=TU_CLIENT_ID
DISCORD_CLIENT_SECRET=TU_CLIENT_SECRET
DISCORD_BOT_TOKEN=TU_TOKEN_DEL_BOT
DEV_PASSWORD=TU_CONTRASEÑA_DEV
DATABASE_PATH=/opt/render/project/src/data/modeos.sqlite
```

Los valores de `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` y `DEV_PASSWORD` son secretos. No los pongas dentro de `index.html` ni los publiques en GitHub.

## 6. Configurar la aplicación Discord

1. Abre Discord Developer Portal.
2. Crea o abre tu aplicación.
3. Copia el `Client ID`.
4. Copia el `Client Secret`.
5. Entra en `OAuth2` y después `Redirects`.
6. Añade exactamente:

```text
https://TU-SERVICIO.onrender.com/auth/discord/callback
```

7. Abre la sección `Bot`.
8. Copia el token del bot y guárdalo solo en Render.
9. Activa estos intents si los necesitas:

```text
Server Members Intent
Message Content Intent
Presence Intent
```

## 7. Conectar GitHub Pages con Render

Abre `index.html` y busca:

```js
https://TU-SERVICIO.onrender.com
```

Sustitúyelo por la URL real de tu servicio Render.

Después vuelve a subir el cambio a GitHub. GitHub Pages actualizará el frontend automáticamente.

## 8. Invitar el bot

Desde el dashboard de Discord, usa el botón para añadir el bot a los servidores. El backend comprueba la presencia real del bot.

Comandos disponibles en la terminal DEV:

```text
!ping
!status
!guilds
!send ID_DEL_CANAL mensaje de prueba
```

## 9. Probar la aplicación

1. Abre la URL de GitHub Pages.
2. Pulsa `Login Discord`.
3. Autoriza la aplicación.
4. Comprueba el dashboard de servidores.
5. Pulsa el botón DEV.
6. Introduce la contraseña configurada en Render.
7. Abre el centro de control de bots.
8. Comprueba los logs en tiempo real.
9. Ejecuta `!ping`.

## 10. Problemas habituales

### GitHub Pages muestra la web, pero Discord no funciona
Comprueba que `index.html` tenga la URL real de Render.

### OAuth devuelve error
Comprueba que el redirect URI de Discord coincida exactamente con:

```text
https://TU-SERVICIO.onrender.com/auth/discord/callback
```

### La terminal indica que el backend no conecta
Comprueba que el Web Service de Render esté activo y que `DISCORD_BOT_TOKEN` sea correcto.

### Se pierden los logs al reiniciar Render
Configura un disco persistente para la carpeta:

```text
/opt/render/project/src/data
```

### Render no inicia
Revisa los logs del servicio y confirma que existan `package.json`, `server.js` y todas las variables obligatorias.

## 11. Checklist final

- [ ] Repositorio subido a GitHub.
- [ ] GitHub Pages activado.
- [ ] Render configurado como Web Service.
- [ ] `npm install` configurado como Build Command.
- [ ] `npm start` configurado como Start Command.
- [ ] `PUBLIC_URL` configurada.
- [ ] `FRONTEND_URL` configurada.
- [ ] `DISCORD_CLIENT_ID` configurado.
- [ ] `DISCORD_CLIENT_SECRET` configurado.
- [ ] `DISCORD_BOT_TOKEN` configurado.
- [ ] `DEV_PASSWORD` configurada.
- [ ] `SESSION_SECRET` configurado.
- [ ] Redirect URI añadida en Discord.
- [ ] Intents del bot activados.
- [ ] URL de Render puesta en `index.html`.
- [ ] Logs en tiempo real comprobados.
- [ ] Comando `!ping` probado.
- [ ] Disco persistente configurado en Render.
