/*
 * Referencia: mapeo servo θ lógico [0,110] ↔ físico (+36° home).
 * Copia setServoLogical / constantes a tu sketch principal del manipulador,
 * o fusiona este archivo con tu .ino del Mega.
 */

#include <Servo.h>

static const int SERVO_HOME_PHYSICAL = 36;
static const int SERVO_LOGICAL_MIN = -36;
static const int SERVO_LOGICAL_MAX = 74;

Servo servoEfector;
int currentServoLogical = 0;

static const int PIN_SERVO = 9;

void servoAttachIfNeeded() {
  static bool attached = false;
  if (!attached) {
    servoEfector.attach(PIN_SERVO);
    attached = true;
  }
}

int logicalToPhysicalWrite(int logicalDeg) {
  logicalDeg = constrain(logicalDeg, SERVO_LOGICAL_MIN, SERVO_LOGICAL_MAX);
  return logicalDeg + SERVO_HOME_PHYSICAL;
}

int physicalWriteToLogical(int physicalDeg) {
  return constrain(physicalDeg - SERVO_HOME_PHYSICAL,
                   SERVO_LOGICAL_MIN, SERVO_LOGICAL_MAX);
}

void setServoLogical(int logicalDeg) {
  servoAttachIfNeeded();
  logicalDeg = constrain(logicalDeg, SERVO_LOGICAL_MIN, SERVO_LOGICAL_MAX);
  currentServoLogical = logicalDeg;
  servoEfector.write(logicalToPhysicalWrite(logicalDeg));
}

void handleServoCommand(const String& cmd) {
  if (cmd.length() < 2) return;
  if (cmd.charAt(0) != 'S' && cmd.charAt(0) != 's') return;
  setServoLogical(cmd.substring(1).toInt());
}

void setup() {
  // Vacío: en tu proyecto real aquí van Serial, motores, HOMEALL, etc.
}

void loop() {}
