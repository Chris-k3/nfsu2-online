# Guía Rápida: Servidor NFS Underground 2 Web (Multijugador 4 Jugadores)

Este repositorio está preconfigurado para jugar **Need for Speed: Underground 2** en el navegador (Chrome, Edge, Firefox) con tus amigos a través de **GitHub Codespaces** (100% gratis, sin tarjeta de crédito).

---

## 🔥 Lo que ya está configurado y optimizado

1. **Mundo Abierto Simultáneo (Free Roam)**:
   - Activado por defecto para todos los jugadores sin necesidad de configurar nada en menús.
   - En cuanto entras a Bayview, ves a tus amigos en tiempo real en las calles y en el minimapa.
2. **Colisiones Físicas Reales (Sin Coches Fantasma)**:
   - `roam_collide = on`: Los coches de los jugadores chocan entre sí con físicas de peso e inercia realistas.
3. **Multijugador hasta 4-6 Jugadores**:
   - Soporta Outruns espontáneos en el mundo libre (acércate a un amigo y pulsa Enter).
   - Lobbies de carreras multijugador directamente en los puntos de carrera del mapa (hasta 6 jugadores).
4. **Inicio Rápido en Codespaces**:
   - Devcontainer automatizado con puerto `8080` configurado como **Público** con HTTPS oficial de GitHub.

---

## 🚀 Pasos para Iniciar el Servidor (Solo tú, el Host)

### Paso 1: Subir este repositorio a tu GitHub

1. Entra a [github.com/new](https://github.com/new) y crea un nuevo repositorio (por ejemplo: `nfsu2-multiplayer`, público o privado).
2. En tu terminal de Windows dentro de esta carpeta, ejecuta:
   ```powershell
   git add .
   git commit -m "NFSU2 Web: 4-Player Multiplayer, Collisions, Codespaces setup"
   git remote set-url origin https://github.com/TU_USUARIO/TU_REPO.git
   git push -u origin main
   ```

---

### Paso 2: Crear el Codespace

1. Ve a la página de tu repositorio en GitHub.
2. Haz clic en el botón verde **`<> Code`** -> pestaña **Codespaces** -> **`Create codespace on main`**.
3. Se abrirá VS Code en tu navegador y comenzará a preparar el entorno Linux automáticamente con `setup.sh`.

---

### Paso 3: Cargar el Juego y Ejecutar

Tienes dos opciones muy sencillas:

#### Opción A (Arrastrar y Soltar tu juego - Recomendado):
1. En tu PC en Windows, ejecuta:
   ```powershell
   .\package-game-for-codespaces.ps1
   ```
   Esto creará un archivo `game.zip` con tu instalación completa de NFS Underground 2.
2. Arrastra y suelta el archivo `game.zip` dentro del explorador de archivos de Codespaces.
3. En la terminal de Codespaces, escribe:
   ```bash
   ./start-server.sh
   ```

#### Opción B (Descarga automática en Codespaces):
Si no quieres subir `game.zip`, simplemente ejecuta en la terminal de Codespaces:
```bash
./start-server.sh
```
El script detectará que no hay archivos y descargará e instalará automáticamente los archivos del juego verificados de Internet Archive.

---

### Paso 4: Compartir el enlace con tus amigos

1. En Codespaces, ve a la pestaña **PORTS** (Puertos) en la parte inferior.
2. Verás el puerto `8080` con visibilidad **Public**.
3. Haz clic derecho en la dirección local o copia la dirección reenviada (**Forwarded Address**), que tendrá un formato como:
   `https://tu-codespace-8080.app.github.dev/`
4. Pásale ese enlace a tus 3 amigos.
5. Todos abren el enlace en **Google Chrome**, presionan **Jugar / Play**, ¡y a quemar llanta en Bayview juntos!
