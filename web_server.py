import logging
from flask import Flask, request, jsonify
import bluetooth_scanner

app = Flask(__name__)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@app.route('/api/forget-device', methods=['POST'])
def forget_device():
    data = request.get_json()
    mac_address = data.get('macAddress')

    if not mac_address:
        return jsonify({"error": "macAddress is required"}), 400

    success = bluetooth_scanner.remove_device(mac_address)
    if success:
        return jsonify({"success": True}), 200
    else:
        return jsonify({"error": "Failed to remove device"}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
