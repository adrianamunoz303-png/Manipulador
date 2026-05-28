# Firmware Arduino (Mega) — manipulador

## Sketch principal

Abre en Arduino IDE la carpeta **`manipulador_lineal/`** (archivo `manipulador_lineal.ino`).

- Comando **`Sθ`**: **θ es el ángulo lógico** [0, 110], el mismo que usa la cinemática en PC/HTML (`Pᵧ`, `Pz` con cos/sen de θ).
- **`θ = 0`** → posición “home” del brazo (horizontal) → internamente se hace `servo.write(0 + SERVO_HOME_PHYSICAL)` con **`SERVO_HOME_PHYSICAL = 36`**.
- **`POS`** y la línea `Servo=…°` reportan **solo el ángulo lógico**, para que coincidan con `manipulator-serial.js` y el panel.
- Tras **`HOMEALL`** se llama **`moverServo(0)`** para dejar el brazo en θ lógico 0 (comenta esa línea en `homingSimultaneo()` si no quieres que el servo se mueva al homing).

Ajusta **`SERVO_HOME_PHYSICAL`** si en tu montaje el horizontal no cae exacto a 36° en el `write()`.

## Referencia mínima (solo offset)

La carpeta `servo_logico_offset/` conserva un ejemplo mínimo del mapeo; el código útil está ya integrado en `manipulador_lineal.ino`.
