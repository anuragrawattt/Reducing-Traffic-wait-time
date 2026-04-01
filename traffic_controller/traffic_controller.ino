/*
 * NexTraffic - AI Arduino Controller with Depth Sensing
 * Receives serial commands from the Web Dashboard
 * Uses 3 HC-SR04 Sensors to ensure lights only change if vehicles are detected.
 * Command format: "J<id>,<redTime>,<greenTime>\n"
 */

// --- Pins Setup ---
// Junction 1
const int J1_RED = 2; const int J1_YEL = 3; const int J1_GRN = 4;
const int J1_TRIG = A0; const int J1_ECHO = A1;

// Junction 2
const int J2_RED = 5; const int J2_YEL = 6; const int J2_GRN = 7;
const int J2_TRIG = A2; const int J2_ECHO = A3;

// Junction 3
const int J3_RED = 8; const int J3_YEL = 9; const int J3_GRN = 10;
const int J3_TRIG = A4; const int J3_ECHO = A5;

// Default timings in seconds (Not strictly used in reactive mode, but kept for compatibility)
int road1RedTime = 30; int road1GreenTime = 30;
int road2RedTime = 30; int road2GreenTime = 30;
int road3RedTime = 30; int road3GreenTime = 30;

// --- Traffic Light State Variables ---
// -1=ALL_RED, 0=J1_GRN, 2=J2_GRN, 4=J3_GRN
int currentState = -1; 
unsigned long manualOverrideEnds = 0; // Tracks when the Web Override expires

// --- Sensor Logic ---
// Function to check if a vehicle is present (distance < 100cm)
bool isVehiclePresent(int trigPin, int echoPin, const char* label) {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);
  
  // Timeout set to ~30ms. Returns 0 if no echo.
  long duration = pulseIn(echoPin, HIGH, 30000UL); 
  
  // MUST have a small delay between sensor pings to prevent hardware freeze/cross-talk
  delay(10);

  if (duration == 0) return false;
  
  float distance = duration * 0.034 / 2;
  
  if (distance > 0 && distance < 100) {
      Serial.print("[SENSOR] "); Serial.print(label);
      Serial.print(" raw distance: "); Serial.println(distance);
      return true;
  }
  
  return false; 
}

// Used to determine the immediate next state
int checkSensors() {
  bool v1 = isVehiclePresent(J1_TRIG, J1_ECHO, "J1");
  bool v2 = isVehiclePresent(J2_TRIG, J2_ECHO, "J2");
  bool v3 = isVehiclePresent(J3_TRIG, J3_ECHO, "J3");
  
  // Instant reaction priority: J1 -> J2 -> J3
  if (v1) return 0; // J1 Green
  if (v2) return 2; // J2 Green
  if (v3) return 4; // J3 Green
  
  return -1; // All Red
}

void setLights(int state) {
  // First, set all to RED
  digitalWrite(J1_RED, HIGH); digitalWrite(J1_YEL, LOW); digitalWrite(J1_GRN, LOW);
  digitalWrite(J2_RED, HIGH); digitalWrite(J2_YEL, LOW); digitalWrite(J2_GRN, LOW);
  digitalWrite(J3_RED, HIGH); digitalWrite(J3_YEL, LOW); digitalWrite(J3_GRN, LOW);

  // Then, override specific green/yellow
  switch(state) {
    case -1: break; // All stay red
    case 0: digitalWrite(J1_RED, LOW); digitalWrite(J1_GRN, HIGH); break;
    case 1: digitalWrite(J1_RED, LOW); digitalWrite(J1_YEL, HIGH); break;
    case 2: digitalWrite(J2_RED, LOW); digitalWrite(J2_GRN, HIGH); break;
    case 3: digitalWrite(J2_RED, LOW); digitalWrite(J2_YEL, HIGH); break;
    case 4: digitalWrite(J3_RED, LOW); digitalWrite(J3_GRN, HIGH); break;
    case 5: digitalWrite(J3_RED, LOW); digitalWrite(J3_YEL, HIGH); break;
  }
}

void setup() {
  Serial.begin(9600);
  
  pinMode(J1_RED, OUTPUT); pinMode(J1_YEL, OUTPUT); pinMode(J1_GRN, OUTPUT);
  pinMode(J2_RED, OUTPUT); pinMode(J2_YEL, OUTPUT); pinMode(J2_GRN, OUTPUT);
  pinMode(J3_RED, OUTPUT); pinMode(J3_YEL, OUTPUT); pinMode(J3_GRN, OUTPUT);
  
  pinMode(J1_TRIG, OUTPUT); pinMode(J1_ECHO, INPUT);
  pinMode(J2_TRIG, OUTPUT); pinMode(J2_ECHO, INPUT);
  pinMode(J3_TRIG, OUTPUT); pinMode(J3_ECHO, INPUT);
  
  Serial.println("NexTraffic Controller + HC-SR04 initialized.");
  setLights(currentState); // Starts ALL_RED (-1) until a car is seen
}

void loop() {
  unsigned long currentMillis = millis();

  // 1. Process Dashboard Commands (Manual Override or AI Routing)
  if (Serial.available() > 0) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    
    if (command.startsWith("J")) {
        int firstComma = command.indexOf(',');
        int secondComma = command.indexOf(',', firstComma + 1);
        
        if (firstComma > 0 && secondComma > 0) {
            int junctionId = command.substring(1, firstComma).toInt();
            int redTime = command.substring(firstComma + 1, secondComma).toInt();
            int greenTime = command.substring(secondComma + 1).toInt();
            
            // Instantly apply Override
            if (junctionId == 1) currentState = 0;
            else if (junctionId == 2) currentState = 2;
            else if (junctionId == 3) currentState = 4;
            
            setLights(currentState);
            
            // Lock out sensors for "greenTime" duration
            manualOverrideEnds = currentMillis + (greenTime * 1000UL);
            
            Serial.print("[OVERRIDE] Locked Road "); Serial.print(junctionId);
            Serial.print(" Green for "); Serial.print(greenTime); Serial.println(" seconds.");
        }
    } else if (command.startsWith("S")) {
        // Direct State Command: "S<junctionId>,<state>" 
        // state: 0=RED, 1=YEL, 2=GRN
        int comma = command.indexOf(',');
        if (comma > 0) {
            int jId = command.substring(1, comma).toInt();
            int state = command.substring(comma + 1).toInt();
            
            if (jId == 1) currentState = (state == 2 ? 0 : (state == 1 ? 1 : -1));
            else if (jId == 2) currentState = (state == 2 ? 2 : (state == 1 ? 3 : -1));
            else if (jId == 3) currentState = (state == 2 ? 4 : (state == 1 ? 5 : -1));
            
            setLights(currentState);
            // Lock out sensors for the full AI cycle window (5 minutes)
            // so sensors never override an AI state command mid-cycle
            manualOverrideEnds = currentMillis + 300000UL;
            Serial.print("[STATE] Road "); Serial.print(jId); Serial.print(" set to "); Serial.println(state);
        }
    }
  }
  
  // 2. Instant Sensor Check Strategy (Only if not in Override mode)
  // Or if override has somehow overflowed (failsafe)
  if (currentMillis >= manualOverrideEnds || manualOverrideEnds - currentMillis > 300000UL) {
      int newState = checkSensors();
      
      if (newState != currentState) {
          currentState = newState;
          setLights(currentState);
      }
  }
  
  // 3. Heartbeat Diagnostic - Prints raw values every 1.5 seconds
  static unsigned long lastDebugPrint = 0;
  if (currentMillis - lastDebugPrint > 1500) {
      lastDebugPrint = currentMillis;
      
      Serial.println("--- SENSOR DIAGNOSTIC ---");
      // Fire J1 manually just for the text log
      digitalWrite(J1_TRIG, LOW); delayMicroseconds(2);
      digitalWrite(J1_TRIG, HIGH); delayMicroseconds(10); digitalWrite(J1_TRIG, LOW);
      long d1 = pulseIn(J1_ECHO, HIGH, 30000UL);
      
      if(d1 == 0) Serial.println("J1: NO ECHO (Check wires!)");
      else { Serial.print("J1: "); Serial.print(d1 * 0.034 / 2); Serial.println(" cm"); }
      Serial.println("-------------------------");
  }
  
  // Crucial Loop Delay: Prevents crashing the HC-SR04 modules
  delay(100);
}
