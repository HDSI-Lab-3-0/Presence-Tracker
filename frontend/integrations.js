// Button injection removed -- handled in index.html

let integrations = [];
let appLinkingConfig = null;

function getAppRouteUrl() {
    return `${window.location.origin}/api/change_status`;
}

function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function buildEncodedLinkingEnvelope() {
    if (!appLinkingConfig?.apiKey) {
        return null;
    }

    const payload = {
        apiUrl: getAppRouteUrl(),
        apiKey: appLinkingConfig.apiKey,
    };

    return {
        encoding: 'base64-json',
        version: 1,
        encodedPayload: encodeBase64Utf8(JSON.stringify(payload)),
        decodeHint: 'Base64 decode encodedPayload, then JSON.parse(decodedString)',
    };
}

function renderAppLinkingQr(containerId = 'app-linking-qr-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const encodedEnvelope = buildEncodedLinkingEnvelope();
    if (!encodedEnvelope) {
        container.innerHTML = '<p style="margin: 0; color: #666;">Rotate or fetch an API key to generate a QR code.</p>';
        return;
    }

    if (typeof QRCode === 'undefined') {
        container.innerHTML = '<p style="margin: 0; color: #a94442;">QRCode library failed to load. Refresh and try again.</p>';
        return;
    }

    const qrData = JSON.stringify(encodedEnvelope);

    container.innerHTML = '';
    const qrNode = document.createElement('div');
    qrNode.style.width = '240px';
    qrNode.style.height = '240px';
    qrNode.style.padding = '8px';
    qrNode.style.border = '1px solid #ddd';
    qrNode.style.borderRadius = '8px';
    qrNode.style.background = '#fff';
    container.appendChild(qrNode);

    new QRCode(qrNode, {
        text: qrData,
        width: 224,
        height: 224,
        correctLevel: QRCode.CorrectLevel.M,
    });

    const hint = document.createElement('p');
    hint.style.marginTop = '0.5rem';
    hint.style.color = '#666';
    hint.style.fontSize = '0.85rem';
    hint.textContent = 'Scan this with the app to import encoded linking settings.';
    container.appendChild(hint);
}

window.openIntegrationsModal = function () {
    const modal = document.getElementById('integrations-modal');
    if (modal) {
        modal.classList.add('active');
        fetchIntegrations();
    }
}

window.closeIntegrationsModal = function () {
    document.getElementById('integrations-modal').classList.remove('active');
}

async function fetchAppLinkingConfig() {
    appLinkingConfig = await window.convexClient.query("devices:getAppLinkingConfig", {});
    return appLinkingConfig;
}

window.openAppQrModal = async function () {
    const modal = document.getElementById('app-qr-modal');
    if (!modal) return;

    modal.classList.add('active');

    const container = document.getElementById('app-linking-qr-standalone');
    if (container) {
        container.innerHTML = '<p style="margin: 0; color: #666;">Loading QR code...</p>';
    }

    try {
        await fetchAppLinkingConfig();
        renderAppLinkingQr('app-linking-qr-standalone');
    } catch (error) {
        if (container) {
            container.innerHTML = '<p style="margin: 0; color: #a94442;">Unable to load QR config right now.</p>';
        }
        console.error('Failed to load app linking config', error);
    }
}

window.closeAppQrModal = function () {
    const modal = document.getElementById('app-qr-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

async function fetchIntegrations() {
    const list = document.getElementById('integrations-list');
    list.innerHTML = 'Loading...';

    try {
        integrations = await window.convexClient.query("integrations:getIntegrations");
        await fetchAppLinkingConfig();
        renderIntegrations();
    } catch (e) {
        list.textContent = 'Error loading integrations.';
        console.error(e);
    }
}

function renderIntegrations() {
    const list = document.getElementById('integrations-list');
    list.innerHTML = '';

    const discord = integrations.find(i => i.type === 'discord');
    const slack = integrations.find(i => i.type === 'slack');

    // Discord Section
    const discordDiv = document.createElement('div');
    discordDiv.className = 'integration-card';
    discordDiv.innerHTML = `
        <h4>Discord</h4>
        <div class="form-group">
            <label>Display Name (Space Name)</label>
            <input type="text" id="discord-display-name" placeholder="Project Space" value="${discord?.config?.displayName || ''}">
        </div>
        <div class="form-group">
            <label>Webhook URL</label>
            <input type="text" id="discord-webhook" placeholder="https://discord.com/api/webhooks/..." value="${discord?.config?.webhookUrl || ''}">
        </div>
        <div class="checkbox-grid">
            <div class="form-group checkbox-group">
                <label class="checkbox-control">
                    <input type="checkbox" id="discord-use-embeds" ${discord?.config?.useEmbeds ? 'checked' : ''}>
                    <div class="checkbox-text">
                        <span class="checkbox-title">Use rich embeds</span>
                        <span class="checkbox-description">Send only the embed version of the status update.</span>
                    </div>
                </label>
            </div>
            <div class="form-group checkbox-group">
                <label class="checkbox-control">
                    <input type="checkbox" id="discord-show-absent" ${discord?.config?.showAbsentUsers ? 'checked' : ''}>
                    <div class="checkbox-text">
                        <span class="checkbox-title">Show "Currently OUT" users</span>
                        <span class="checkbox-description">Include people who are currently marked as out.</span>
                    </div>
                </label>
            </div>
        </div>
        <div class="form-actions">
           <label class="switch">
              <input type="checkbox" id="discord-enabled" ${discord?.isEnabled ? 'checked' : ''}>
              <span class="slider"></span> Enabled
           </label>
           <button class="btn btn-primary" onclick="saveDiscord()">Save</button>
        </div>
    `;
    list.appendChild(discordDiv);

    // Slack Section
    const slackDiv = document.createElement('div');
    slackDiv.className = 'integration-card';
    slackDiv.innerHTML = `
        <h4>Slack</h4>
        <div class="form-group">
            <label>Display Name (Space Name)</label>
            <input type="text" id="slack-display-name" placeholder="Project Space" value="${slack?.config?.displayName || ''}">
        </div>
        <div class="form-group">
            <label>Bot User OAuth Token (xoxb-...)</label>
            <input type="text" id="slack-token" placeholder="xoxb-..." value="${slack?.config?.botToken || ''}">
        </div>
        <div class="form-group">
            <label>Channel ID</label>
            <input type="text" id="slack-channel" placeholder="C12345678" value="${slack?.config?.channelId || ''}">
        </div>
        <div class="form-group checkbox-group">
            <label class="checkbox-control">
                <input type="checkbox" id="slack-show-absent" ${slack?.config?.showAbsentUsers ? 'checked' : ''}>
                <div class="checkbox-text">
                    <span class="checkbox-title">Show "Currently OUT" users</span>
                    <span class="checkbox-description">Adds an absent list beneath the present users.</span>
                </div>
            </label>
        </div>
        <div class="form-actions">
           <label class="switch">
              <input type="checkbox" id="slack-enabled" ${slack?.isEnabled ? 'checked' : ''}>
               <span class="slider"></span> Enabled
           </label>
           <button class="btn btn-primary" onclick="saveSlack()">Save</button>
        </div>
    `;
    list.appendChild(slackDiv);

    const mobileApiDiv = document.createElement('div');
    mobileApiDiv.className = 'integration-card';
    mobileApiDiv.innerHTML = `
        <h4>Mobile App Linking</h4>
        <div class="form-group">
            <label>API Route</label>
            <input type="text" id="app-route" value="${getAppRouteUrl()}" readonly>
        </div>
        <div class="form-group">
            <label>API Key</label>
            <input type="text" id="app-api-key" value="${appLinkingConfig?.apiKey || ''}" readonly>
        </div>
        <div class="form-group">
            <label>Key Version</label>
            <input type="text" id="app-key-version" value="${appLinkingConfig?.keyVersion || 1}" readonly>
        </div>
        <div class="form-actions" style="justify-content: flex-end; gap: 0.5rem;">
            <button class="btn btn-secondary" onclick="downloadAppLinkingJson()">Download JSON</button>
            <button class="btn btn-primary" onclick="rotateAppApiKey()">Rotate Key</button>
        </div>
        <div class="form-group" style="margin-top: 1rem;">
            <label>QR Code</label>
            <div id="app-linking-qr-container" style="display: flex; flex-direction: column; align-items: flex-start;"></div>
        </div>
    `;
    list.appendChild(mobileApiDiv);

    renderAppLinkingQr('app-linking-qr-container');
}

window.saveDiscord = async function () {
    const webhookUrl = document.getElementById('discord-webhook').value.trim();
    const isEnabled = document.getElementById('discord-enabled').checked;
    const displayName = document.getElementById('discord-display-name').value.trim();
    const useEmbeds = document.getElementById('discord-use-embeds').checked;
    const showAbsentUsers = document.getElementById('discord-show-absent').checked;
    const adminPassword = sessionStorage.getItem('ieee_presence_password');

    if (!adminPassword) {
        showToast('Please log in again as admin', 'error');
        return;
    }

    try {
        await window.convexClient.mutation("integrations:saveIntegration", {
            adminPassword,
            type: "discord",
            config: { 
                webhookUrl, 
                displayName: displayName || undefined,
                useEmbeds,
                showAbsentUsers
            },
            isEnabled
        });
        showToast('Discord settings saved');
    } catch (e) {
        showToast('Error saving Discord: ' + e.message, 'error');
    }
}

window.saveSlack = async function () {
    const botToken = document.getElementById('slack-token').value.trim();
    const channelId = document.getElementById('slack-channel').value.trim();
    const isEnabled = document.getElementById('slack-enabled').checked;
    const displayName = document.getElementById('slack-display-name').value.trim();
    const showAbsentUsers = document.getElementById('slack-show-absent').checked;
    const adminPassword = sessionStorage.getItem('ieee_presence_password');

    if (!adminPassword) {
        showToast('Please log in again as admin', 'error');
        return;
    }

    try {
        await window.convexClient.mutation("integrations:saveIntegration", {
            adminPassword,
            type: "slack",
            config: { 
                botToken, 
                channelId,
                displayName: displayName || undefined,
                showAbsentUsers
            },
            isEnabled
        });
        showToast('Slack settings saved');
    } catch (e) {
        showToast('Error saving Slack: ' + e.message, 'error');
    }
}

window.rotateAppApiKey = async function () {
    const adminPassword = sessionStorage.getItem('ieee_presence_password');
    if (!adminPassword) {
        showToast('Please log in again as admin', 'error');
        return;
    }

    try {
        appLinkingConfig = await window.convexClient.mutation("devices:rotateAppApiKey", { adminPassword });
        renderIntegrations();
        showToast('App API key rotated');
    } catch (e) {
        showToast('Error rotating app key: ' + e.message, 'error');
    }
}

window.downloadAppLinkingJson = function () {
    if (!appLinkingConfig?.apiKey) {
        showToast('No API key available yet. Rotate key first.', 'error');
        return;
    }

    const encodedEnvelope = buildEncodedLinkingEnvelope();
    if (!encodedEnvelope) {
        showToast('No API key available yet. Rotate key first.', 'error');
        return;
    }

    const blob = new Blob([JSON.stringify(encodedEnvelope, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `presence-app-linking-encoded-v${appLinkingConfig.keyVersion || 1}.json`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('Encoded linking JSON downloaded', 'success');
}

window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;

    const integrationsModal = document.getElementById('integrations-modal');
    if (integrationsModal?.classList.contains('active')) {
        closeIntegrationsModal();
    }

    const appQrModal = document.getElementById('app-qr-modal');
    if (appQrModal?.classList.contains('active')) {
        closeAppQrModal();
    }
});

window.addEventListener('click', (event) => {
    const integrationsModal = document.getElementById('integrations-modal');
    if (event.target === integrationsModal) {
        closeIntegrationsModal();
    }

    const appQrModal = document.getElementById('app-qr-modal');
    if (event.target === appQrModal) {
        closeAppQrModal();
    }
});
