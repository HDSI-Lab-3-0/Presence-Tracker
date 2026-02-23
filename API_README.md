# Presence Tracker API README

This document explains the app-facing API routes, authentication, payloads, and how to use the encoded linking JSON file.

## Base URL

Use your frontend server origin, for example:

- Local: `http://localhost:3132`
- Deployed: `https://your-domain.example`

---

## Route Index

### 1) `POST /api/change_status`
Flip a user app status between `present` and `absent` by UCSD email.

- Auth: **Required** (`Authorization: Bearer <apiKey>`)
- Content-Type: `application/json`
- Body:

```json
{
  "email": "student@ucsd.edu",
  "latitude": 32.88071867959147,
  "longitude": -117.23379676539253
}
```

`latitude` / `longitude` are optional when boundary checks are disabled, and required when boundary checks are enabled.

#### Success Response (200)

```json
{
  "success": true,
  "appStatus": "present",
  "email": "student@ucsd.edu",
  "keyVersion": 3
}
```

#### Error Responses

- `400` invalid JSON or missing email
- `401` missing Bearer API key
- `405` method not allowed
- `403` outside boundary when boundary checks are enabled
- `400` invalid API key / backend validation errors

#### cURL Example

```bash
curl -X POST "http://localhost:3132/api/change_status" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"student@ucsd.edu","latitude":32.88071867959147,"longitude":-117.23379676539253}'
```

---

### 2) `POST /api/fetch`
Fetch startup check-in context for a user (used by app startup auto-fetch flow).

- Auth: **Required** (`Authorization: Bearer <apiKey>`)
- Content-Type: `application/json`
- Body:

```json
{
  "email": "student@ucsd.edu"
}
```

#### Success Response (200)

```json
{
  "success": true,
  "email": "student@ucsd.edu",
  "appStatus": "absent",
  "keyVersion": 3,
  "boundaryEnabled": true,
  "boundaryLatitude": 32.88071867959147,
  "boundaryLongitude": -117.23379676539253,
  "boundaryRadius": 0.6,
  "boundaryRadiusUnit": "miles"
}
```

#### cURL Example

```bash
curl -X POST "http://localhost:3132/api/fetch" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"student@ucsd.edu"}'
```

---

### 3) `OPTIONS /api/change_status` and `OPTIONS /api/fetch`
CORS preflight endpoint for mobile/web clients.

#### Success Response (200)

```json
{
  "ok": true
}
```

---

## Encoded Linking JSON

From **Settings → Mobile App Linking → Download JSON**, the exported file is now an encoded envelope:

```json
{
  "encoding": "base64-json",
  "version": 1,
  "encodedPayload": "eyJhcGlVcmwiOiJodHRwczovL2V4YW1wbGUuY29tL2FwaS9jaGFuZ2Vfc3RhdHVzIiwiYXBpS2V5IjoiLi4uIn0=",
  "decodeHint": "Base64 decode encodedPayload, then JSON.parse(decodedString)"
}
```

The decoded payload shape is:

```json
{
  "apiUrl": "https://your-domain.example/api/change_status",
  "apiKey": "YOUR_API_KEY"
}
```

### JavaScript decode example

```js
const envelope = JSON.parse(fileText);
const decodedJson = atob(envelope.encodedPayload);
const linking = JSON.parse(decodedJson);
// linking.apiUrl
// linking.apiKey
```

### Swift decode example

```swift
struct LinkingEnvelope: Codable {
    let encoding: String
    let version: Int
    let encodedPayload: String
}

struct LinkingPayload: Codable {
    let apiUrl: String
    let apiKey: String
}

let envelope = try JSONDecoder().decode(LinkingEnvelope.self, from: data)
guard let decodedData = Data(base64Encoded: envelope.encodedPayload) else { throw NSError() }
let payload = try JSONDecoder().decode(LinkingPayload.self, from: decodedData)
```

### Kotlin decode example

```kotlin
val envelope = JSONObject(fileText)
val encoded = envelope.getString("encodedPayload")
val decoded = String(Base64.decode(encoded, Base64.DEFAULT), Charsets.UTF_8)
val linking = JSONObject(decoded)
val apiUrl = linking.getString("apiUrl")
val apiKey = linking.getString("apiKey")
```

---

## Operational Notes

1. API keys are rotated in admin settings.
2. When rotating, update the app with the newly exported linking JSON.
3. Email must match a registered device UCSD email (`@ucsd.edu`).
4. This route toggles status each call (it does not force a specific target status).
