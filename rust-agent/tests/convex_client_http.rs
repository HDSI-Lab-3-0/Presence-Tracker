use presence_tracker_rs::convex_client::ConvexClient;
use serde_json::json;
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn parses_wrapped_value_response() {
    let server = MockServer::start().await;

    let response = json!({
        "value": [
            {
                "_id": "abc",
                "macAddress": "AA:BB:CC:DD:EE:FF",
                "status": "absent",
                "pendingRegistration": false
            }
        ]
    });

    Mock::given(method("POST"))
        .and(path("/api/query"))
        .and(body_partial_json(json!({
            "path": "devices:getDevices"
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(response))
        .mount(&server)
        .await;

    let client = ConvexClient::new(server.uri(), None).unwrap();
    let devices = client.get_devices().await.unwrap();

    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].mac_address, "AA:BB:CC:DD:EE:FF");
}
