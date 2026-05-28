# Robótica 2

Proyecto de manipulador lineal 3 ejes + servo (PPP+R).

## Hardware
- Arduino Mega (esclavo serial) — sketch en `arduino/manipulador_lineal/` (ver `arduino/README.md`).
- Raspberry Pi (maestro, servidor Node.js)
- Ejes: X=265mm, Y=190mm, Z=120mm, Servo=0-110°

## Panel en la Raspberry

Con la Pi encendida y el proyecto en `~/moule3d` (con `server.js`):

```bash
# Desde tu Mac, en la carpeta del repo:
./scripts/pi-arrancar-panel.sh
# o: npm run pi:panel

# Arranque en segundo plano en la Pi (sin bloquear SSH):
BACKGROUND=1 ./scripts/pi-arrancar-panel.sh
```

IP por defecto en los scripts: **192.168.68.130**. Panel: `http://192.168.68.130:3000/manipulador` (si cambia la red: `PI_HOST=... ./scripts/pi-arrancar-panel.sh`).

## Estructura
```
robotica2/
├── src/          # Código fuente Python / Node.js
├── scripts/      # Scripts de utilidad
├── docs/         # Documentación y reportes
└── README.md
```
