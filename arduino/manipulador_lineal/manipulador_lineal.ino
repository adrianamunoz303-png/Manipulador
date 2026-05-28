// ══════════════════════════════════════════
//  MANIPULADOR LINEAL — COMPLETO FINAL
//  EJE X: ENA=10 DIR=11  STEP=13  FC=A1
//  EJE Y: ENA=49 DIR=50  STEP=51  FC=A3
//  EJE Z: ENA=7  DIR=6   STEP=5   FC=A2
//  SERVO: Pin=A4  Rango=0-110°
//  DS1=ON DS4=ON — 800 pasos/vuelta
// ══════════════════════════════════════════

#include <Servo.h>

// ── EJE X ──
#define X_ENA   10
#define X_DIR   11
#define X_STEP  13
#define X_MIN   A1

// ── EJE Y ──
#define Y_ENA   49
#define Y_DIR   50
#define Y_STEP  51
#define Y_MIN   A3

// ── EJE Z ──
#define Z_ENA   7
#define Z_DIR   6
#define Z_STEP  5
#define Z_MIN   A2

// ── SERVO ──
#define SERVO_PIN  A4
#define SERVO_MIN  0
#define SERVO_MAX  110

// ── PARÁMETROS ──
#define X_PASOS_POR_CM    2023
#define Y_PASOS_POR_CM    2120
#define Z_PASOS_POR_CM    1003

#define X_LIMITE          265.0
#define Y_LIMITE          190.0
#define Z_LIMITE          120.0

#define VEL_NORMAL        100
#define VEL_HOMING        150

// ── POSICIÓN ACTUAL ──
float posX     = 0.0;
float posY     = 0.0;
float posZ     = 0.0;
int   posServo = 55;

bool homingX = false;
bool homingY = false;
bool homingZ = false;

Servo servo;
String inputBuffer = "";

// ══════════════════════════════════════════
void setup() {
  Serial.begin(9600);

  // EJE X
  pinMode(X_STEP, OUTPUT); pinMode(X_DIR, OUTPUT); pinMode(X_ENA, OUTPUT);
  pinMode(X_MIN,  INPUT_PULLUP);
  digitalWrite(X_STEP, LOW); digitalWrite(X_DIR, LOW); digitalWrite(X_ENA, HIGH);

  // EJE Y
  pinMode(Y_STEP, OUTPUT); pinMode(Y_DIR, OUTPUT); pinMode(Y_ENA, OUTPUT);
  pinMode(Y_MIN,  INPUT_PULLUP);
  digitalWrite(Y_STEP, LOW); digitalWrite(Y_DIR, LOW); digitalWrite(Y_ENA, HIGH);

  // EJE Z
  pinMode(Z_STEP, OUTPUT); pinMode(Z_DIR, OUTPUT); pinMode(Z_ENA, OUTPUT);
  pinMode(Z_MIN,  INPUT_PULLUP);
  digitalWrite(Z_STEP, LOW); digitalWrite(Z_DIR, LOW); digitalWrite(Z_ENA, HIGH);

  // SERVO
  servo.attach(SERVO_PIN);
  servo.write(posServo);

  Serial.println("=====================================");
  Serial.println("  MANIPULADOR LINEAL — COMPLETO");
  Serial.println("=====================================");
  Serial.println("  HOMEALL    = homing 3 ejes a la vez");
  Serial.println("  HOMEX/Y/Z  = homing individual");
  Serial.println("  X10        = mover X 10mm");
  Serial.println("  Y50        = mover Y 50mm");
  Serial.println("  Y-50       = retroceder Y 50mm");
  Serial.println("  Z25        = mover Z 25mm");
  Serial.println("  S55        = servo a 55 grados");
  Serial.println("  POS        = posicion actual");
  Serial.println("  STOP       = deshabilitar motores");
  Serial.println("  ON         = habilitar motores");
  Serial.println("=====================================");
  Serial.println("Manda HOMEALL primero");
}

// ══════════════════════════════════════════
bool fcActivo(int pin) {
  return digitalRead(pin) == LOW;
}

void reportarPos() {
  Serial.print("X="); Serial.print(posX);
  Serial.print("mm  Y="); Serial.print(posY);
  Serial.print("mm  Z="); Serial.print(posZ);
  Serial.print("mm  Servo="); Serial.print(posServo);
  Serial.println("°");
}

// ══════════════════════════════════════════
//  SERVO
// ══════════════════════════════════════════
void moverServo(int grados) {
  if (grados < SERVO_MIN) grados = SERVO_MIN;
  if (grados > SERVO_MAX) grados = SERVO_MAX;
  servo.write(grados);
  posServo = grados;
  Serial.print("Servo en: ");
  Serial.print(posServo);
  Serial.println(" grados");
}

// ══════════════════════════════════════════
//  PASO INDIVIDUAL
// ══════════════════════════════════════════
void darPasoX(unsigned int vel) {
  digitalWrite(X_STEP, HIGH); delayMicroseconds(vel);
  digitalWrite(X_STEP, LOW);  delayMicroseconds(vel);
}
void darPasoY(unsigned int vel) {
  digitalWrite(Y_STEP, HIGH); delayMicroseconds(vel);
  digitalWrite(Y_STEP, LOW);  delayMicroseconds(vel);
}
void darPasoZ(unsigned int vel) {
  digitalWrite(Z_STEP, HIGH); delayMicroseconds(vel);
  digitalWrite(Z_STEP, LOW);  delayMicroseconds(vel);
}

// ══════════════════════════════════════════
//  HOMING INDIVIDUAL
// ══════════════════════════════════════════
void homingX_fn() {
  Serial.println("Homing X...");
  digitalWrite(X_DIR, HIGH); delayMicroseconds(100);
  while (!fcActivo(X_MIN)) { darPasoX(VEL_HOMING); }
  Serial.println("X limite — separando 2mm...");
  digitalWrite(X_DIR, LOW); delayMicroseconds(100);
  long sep = (long)(0.2 * X_PASOS_POR_CM);
  for (long i = 0; i < sep; i++) darPasoX(VEL_HOMING);
  posX = 2.0; homingX = true;
  Serial.println("X — ORIGEN OK"); reportarPos();
}

void homingY_fn() {
  Serial.println("Homing Y...");
  // Y usa !dir — para buscar FC mandamos HIGH al pin (que con !dir va LOW físicamente)
  digitalWrite(Y_DIR, HIGH); delayMicroseconds(100);
  while (!fcActivo(Y_MIN)) { darPasoY(VEL_HOMING); }
  Serial.println("Y limite — separando 2mm...");
  // para separarse mandamos LOW al pin (que con !dir va HIGH físicamente)
  digitalWrite(Y_DIR, LOW); delayMicroseconds(100);
  long sep = (long)(0.2 * Y_PASOS_POR_CM);
  for (long i = 0; i < sep; i++) darPasoY(VEL_HOMING);
  posY = 2.0; homingY = true;
  Serial.println("Y — ORIGEN OK"); reportarPos();
}

void homingZ_fn() {
  Serial.println("Homing Z...");
  digitalWrite(Z_DIR, LOW); delayMicroseconds(100);
  while (!fcActivo(Z_MIN)) { darPasoZ(VEL_HOMING); }
  Serial.println("Z limite — separando 2mm...");
  digitalWrite(Z_DIR, HIGH); delayMicroseconds(100);
  long sep = (long)(0.2 * Z_PASOS_POR_CM);
  for (long i = 0; i < sep; i++) darPasoZ(VEL_HOMING);
  posZ = 2.0; homingZ = true;
  Serial.println("Z — ORIGEN OK"); reportarPos();
}

// ══════════════════════════════════════════
//  HOMING SIMULTÁNEO
// ══════════════════════════════════════════
void homingSimultaneo() {
  Serial.println("Buscando origen en los 3 ejes...");

  digitalWrite(X_DIR, HIGH);
  digitalWrite(Y_DIR, HIGH);
  digitalWrite(Z_DIR, LOW);
  delayMicroseconds(100);

  bool xListo = fcActivo(X_MIN);
  bool yListo = fcActivo(Y_MIN);
  bool zListo = fcActivo(Z_MIN);

  while (!xListo || !yListo || !zListo) {
    if (!xListo) digitalWrite(X_STEP, HIGH);
    if (!yListo) digitalWrite(Y_STEP, HIGH);
    if (!zListo) digitalWrite(Z_STEP, HIGH);
    delayMicroseconds(VEL_HOMING);
    if (!xListo) digitalWrite(X_STEP, LOW);
    if (!yListo) digitalWrite(Y_STEP, LOW);
    if (!zListo) digitalWrite(Z_STEP, LOW);
    delayMicroseconds(VEL_HOMING);

    if (!xListo && fcActivo(X_MIN)) { xListo = true; Serial.println("X — limite encontrado"); }
    if (!yListo && fcActivo(Y_MIN)) { yListo = true; Serial.println("Y — limite encontrado"); }
    if (!zListo && fcActivo(Z_MIN)) { zListo = true; Serial.println("Z — limite encontrado"); }
  }

  Serial.println("Separando...");
  digitalWrite(X_DIR, LOW);
  digitalWrite(Y_DIR, LOW);
  digitalWrite(Z_DIR, HIGH);
  delayMicroseconds(100);

  long separar = (long)(0.2 * X_PASOS_POR_CM);
  for (long i = 0; i < separar; i++) {
    digitalWrite(X_STEP, HIGH);
    digitalWrite(Y_STEP, HIGH);
    digitalWrite(Z_STEP, HIGH);
    delayMicroseconds(VEL_HOMING);
    digitalWrite(X_STEP, LOW);
    digitalWrite(Y_STEP, LOW);
    digitalWrite(Z_STEP, LOW);
    delayMicroseconds(VEL_HOMING);
  }

  posX = 2.0; posY = 2.0; posZ = 2.0;
  homingX = true; homingY = true; homingZ = true;
  Serial.println("HOMEALL completo");
  reportarPos();
}

// ══════════════════════════════════════════
//  MOVER EJES
// ══════════════════════════════════════════
void moverX(float mm) {
  if (!homingX) { Serial.println("Haz HOMEX o HOMEALL primero"); return; }
  float destino = posX + mm;
  if (destino < 0)        { mm = -posX;           destino = 0;        Serial.println("! LIMITE MINIMO X"); }
  if (destino > X_LIMITE) { mm = X_LIMITE - posX; destino = X_LIMITE; Serial.println("! LIMITE MAXIMO X"); }
  if (mm == 0) { Serial.println("Ya esta en el limite"); return; }
  bool avanzando = mm > 0;
  digitalWrite(X_DIR, avanzando ? LOW : HIGH);
  delayMicroseconds(100);
  long pasos = abs((long)(mm / 10.0 * X_PASOS_POR_CM));
  for (long i = 0; i < pasos; i++) {
    if (!avanzando && fcActivo(X_MIN)) { posX = 0.0; Serial.println("! FC X"); return; }
    darPasoX(VEL_NORMAL);
  }
  posX = destino;
}

void moverY(float mm) {
  if (!homingY) { Serial.println("Haz HOMEY o HOMEALL primero"); return; }
  float destino = posY + mm;
  if (destino < 0)        { mm = -posY;           destino = 0;        Serial.println("! LIMITE MINIMO Y"); }
  if (destino > Y_LIMITE) { mm = Y_LIMITE - posY; destino = Y_LIMITE; Serial.println("! LIMITE MAXIMO Y"); }
  if (mm == 0) { Serial.println("Ya esta en el limite"); return; }
  bool avanzando = mm > 0;
  // Y usa !dir — avanzar manda LOW al pin, retroceder manda HIGH
  digitalWrite(Y_DIR, avanzando ? LOW : HIGH);
  delayMicroseconds(100);
  long pasos = abs((long)(mm / 10.0 * Y_PASOS_POR_CM));
  for (long i = 0; i < pasos; i++) {
    if (!avanzando && fcActivo(Y_MIN)) { posY = 0.0; Serial.println("! FC Y"); return; }
    darPasoY(VEL_NORMAL);
  }
  posY = destino;
}

void moverZ(float mm) {
  if (!homingZ) { Serial.println("Haz HOMEZ o HOMEALL primero"); return; }
  float destino = posZ + mm;
  if (destino < 0)        { mm = -posZ;           destino = 0;        Serial.println("! LIMITE MINIMO Z"); }
  if (destino > Z_LIMITE) { mm = Z_LIMITE - posZ; destino = Z_LIMITE; Serial.println("! LIMITE MAXIMO Z"); }
  if (mm == 0) { Serial.println("Ya esta en el limite"); return; }
  bool avanzando = mm > 0;
  digitalWrite(Z_DIR, avanzando ? HIGH : LOW);
  delayMicroseconds(100);
  long pasos = abs((long)(mm / 10.0 * Z_PASOS_POR_CM));
  for (long i = 0; i < pasos; i++) {
    if (!avanzando && fcActivo(Z_MIN)) { posZ = 0.0; Serial.println("! FC Z"); return; }
    darPasoZ(VEL_NORMAL);
  }
  posZ = destino;
}

// ══════════════════════════════════════════
//  TEST DE MOTORES (sin homing, sin finales de carrera)
// ══════════════════════════════════════════
void testMotorX() {
  Serial.println("TEST X — 2cm adelante (sin homing, sin FC)...");
  digitalWrite(X_ENA, HIGH);
  digitalWrite(X_DIR, LOW);
  delayMicroseconds(100);
  long pasos = (long)(2.0 / 10.0 * X_PASOS_POR_CM);
  for (long i = 0; i < pasos; i++) darPasoX(VEL_NORMAL);
  Serial.println("TEST X OK");
}

void testMotorY() {
  Serial.println("TEST Y — 2cm adelante (sin homing, sin FC)...");
  digitalWrite(Y_ENA, HIGH);
  digitalWrite(Y_DIR, LOW);
  delayMicroseconds(100);
  long pasos = (long)(2.0 / 10.0 * Y_PASOS_POR_CM);
  for (long i = 0; i < pasos; i++) darPasoY(VEL_NORMAL);
  Serial.println("TEST Y OK");
}

void testMotorZ() {
  Serial.println("TEST Z — 2cm adelante (sin homing, sin FC)...");
  digitalWrite(Z_ENA, HIGH);
  digitalWrite(Z_DIR, HIGH);
  delayMicroseconds(100);
  long pasos = (long)(2.0 / 10.0 * Z_PASOS_POR_CM);
  for (long i = 0; i < pasos; i++) darPasoZ(VEL_NORMAL);
  Serial.println("TEST Z OK");
}

void testTodos() {
  Serial.println("TEST ALL — moviendo los 3 ejes 2cm...");
  digitalWrite(X_ENA, HIGH); digitalWrite(Y_ENA, HIGH); digitalWrite(Z_ENA, HIGH);
  digitalWrite(X_DIR, LOW);  digitalWrite(Y_DIR, LOW);  digitalWrite(Z_DIR, HIGH);
  delayMicroseconds(100);
  long pasosX = (long)(2.0 / 10.0 * X_PASOS_POR_CM);
  long pasosY = (long)(2.0 / 10.0 * Y_PASOS_POR_CM);
  long pasosZ = (long)(2.0 / 10.0 * Z_PASOS_POR_CM);
  long maxPasos = max(pasosX, max(pasosY, pasosZ));
  for (long i = 0; i < maxPasos; i++) {
    if (i < pasosX) { digitalWrite(X_STEP, HIGH); }
    if (i < pasosY) { digitalWrite(Y_STEP, HIGH); }
    if (i < pasosZ) { digitalWrite(Z_STEP, HIGH); }
    delayMicroseconds(VEL_NORMAL);
    if (i < pasosX) { digitalWrite(X_STEP, LOW); }
    if (i < pasosY) { digitalWrite(Y_STEP, LOW); }
    if (i < pasosZ) { digitalWrite(Z_STEP, LOW); }
    delayMicroseconds(VEL_NORMAL);
  }
  Serial.println("TEST ALL OK");
}

// ══════════════════════════════════════════
//  PROCESAR COMANDOS
// ══════════════════════════════════════════
void procesarComando(String cmd) {
  cmd.trim();
  cmd.toUpperCase();

  if      (cmd == "HOMEALL") homingSimultaneo();
  else if (cmd == "HOMEX")   homingX_fn();
  else if (cmd == "HOMEY")   homingY_fn();
  else if (cmd == "HOMEZ")   homingZ_fn();
  else if (cmd == "TESTX")   testMotorX();
  else if (cmd == "TESTY")   testMotorY();
  else if (cmd == "TESTZ")   testMotorZ();
  else if (cmd == "TESTALL") testTodos();
  else if (cmd == "POS")     reportarPos();
  else if (cmd == "STOP") {
    digitalWrite(X_ENA, LOW);
    digitalWrite(Y_ENA, LOW);
    digitalWrite(Z_ENA, LOW);
    Serial.println("Motores deshabilitados");
  }
  else if (cmd == "ON") {
    digitalWrite(X_ENA, HIGH);
    digitalWrite(Y_ENA, HIGH);
    digitalWrite(Z_ENA, HIGH);
    Serial.println("Motores habilitados");
  }
  else if (cmd.length() > 1 && cmd[0] == 'S' && isDigit(cmd[1])) {
    int grados = cmd.substring(1).toInt();
    moverServo(grados);
  }
  else if (cmd.length() > 1 && (cmd[0]=='X' || cmd[0]=='Y' || cmd[0]=='Z')) {
    float mm = cmd.substring(1).toFloat();
    if      (cmd[0] == 'X') { Serial.print("X "); Serial.print(mm); Serial.println("mm..."); moverX(mm); reportarPos(); }
    else if (cmd[0] == 'Y') { Serial.print("Y "); Serial.print(mm); Serial.println("mm..."); moverY(mm); reportarPos(); }
    else if (cmd[0] == 'Z') { Serial.print("Z "); Serial.print(mm); Serial.println("mm..."); moverZ(mm); reportarPos(); }
  }
  else {
    Serial.println("Comandos: HOMEALL HOMEX/Y/Z X10 Y50 Y-50 Z25 S55 POS STOP ON");
  }
}

// ══════════════════════════════════════════
void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (inputBuffer.length() > 0) {
        procesarComando(inputBuffer);
        inputBuffer = "";
      }
    } else {
      inputBuffer += c;
    }
  }
}
