const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(bodyParser.json());

// --- CONFIGURAÇÕES ---
let rawUrl = process.env.CHATWOOT_URL || "";
if (rawUrl.endsWith('/')) rawUrl = rawUrl.slice(0, -1);
rawUrl = rawUrl.replace("https://https://", "https://");
rawUrl = rawUrl.replace("http://https://", "https://");
if (!rawUrl.startsWith("http")) rawUrl = `https://${rawUrl}`;

const CHATWOOT_URL = rawUrl;
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || 1;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || 1;

const ZAPI_INSTANCE_ID = (process.env.ZAPI_INSTANCE_ID || "").trim();
const ZAPI_TOKEN = (process.env.ZAPI_TOKEN || "").trim();
const ZAPI_CLIENT_TOKEN = (process.env.ZAPI_CLIENT_TOKEN || "").trim();
const ZAPI_BASE_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

// =======================================================================
// ROTA 1: ENTRADA (Z-API -> CHATWOOT)
// =======================================================================
app.post('/webhook/zapi', async (req, res) => {
    res.status(200).send('Webhook recebido');

    try {
        const data = req.body;
        if (data.type !== 'ReceivedCallback' || data.isGroup) return;

        const phone = data.phone;
        const senderName = data.senderName || `Cliente ${phone}`;
        
        let textContent = '';
        let attachmentUrl = null;
        let attachmentName = 'file.bin';
        let attachmentMime = 'application/octet-stream'; // Padrão genérico

        // --- DETECÇÃO AVANÇADA DE TIPO ---
        if (data.text) {
            textContent = (typeof data.text === 'string') ? data.text : data.text.message;
        } 
        else if (data.audio) {
            attachmentUrl = data.audio.audioUrl;
            attachmentName = 'audio.ogg'; 
            attachmentMime = 'audio/ogg'; // Força o tipo OGG (padrão WhatsApp)
            textContent = ''; 
        } 
        else if (data.image) {
            attachmentUrl = data.image.imageUrl;
            attachmentName = 'image.jpeg';
            attachmentMime = 'image/jpeg';
            textContent = data.image.caption || '';
        } 
        else if (data.document) {
            attachmentUrl = data.document.documentUrl;
            attachmentName = data.document.fileName || 'document.pdf';
            // Tenta adivinhar mime simples ou usa pdf
            attachmentMime = attachmentName.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
            textContent = data.document.caption || '';
        }
        else if (data.video) {
            attachmentUrl = data.video.videoUrl;
            attachmentName = 'video.mp4';
            attachmentMime = 'video/mp4';
            textContent = data.video.caption || '';
        }

        if (!textContent && !attachmentUrl) return;

        let finalSourceId = null;

        // Lógica de Contato (Simplificada para foco no upload)
        try {
            const createRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`, {
                inbox_id: CHATWOOT_INBOX_ID, name: senderName, phone_number: `+${phone}`
            }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
            finalSourceId = createRes.data.payload.contact_inbox.source_id;
        } catch (err) {
            if (err.response && (err.response.status === 422 || err.response.data?.message?.includes('taken'))) {
                const searchRes = await axios.get(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${phone}`, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
                if (searchRes.data.payload.length > 0) {
                    const contact = searchRes.data.payload[0];
                    const inboxLink = contact.contact_inboxes.find(i => i.inbox_id == CHATWOOT_INBOX_ID);
                    finalSourceId = inboxLink ? inboxLink.source_id : (await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/${contact.id}/contact_inboxes`, { inbox_id: CHATWOOT_INBOX_ID }, { headers: { 'api_access_token': CHATWOOT_TOKEN } })).data.source_id;
                }
            }
        }

        if (!finalSourceId) return;

        const convRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`, {
            source_id: finalSourceId, inbox_id: CHATWOOT_INBOX_ID, status: 'open'
        }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });

        const conversationId = convRes.data.id;
        const messagesUrl = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;

        if (attachmentUrl) {
            console.log(`📥 Baixando mídia (${attachmentMime}): ${attachmentUrl}`);
            
            try {
                const fileResponse = await axios.get(attachmentUrl, { responseType: 'stream' });
                
                const form = new FormData();
                form.append('content', textContent);
                form.append('message_type', 'incoming');
                form.append('private', 'false');
                
                // [ATUALIZAÇÃO CRUCIAL] Passando opções de arquivo explícitas
                form.append('attachments[]', fileResponse.data, {
                    filename: attachmentName,
                    contentType: attachmentMime,
                    knownLength: fileResponse.headers['content-length'] // Ajuda no processamento
                });

                await axios.post(messagesUrl, form, {
                    headers: {
                        'api_access_token': CHATWOOT_TOKEN,
                        ...form.getHeaders()
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                });
                console.log("✅ Arquivo enviado (MIME forçado)!");

            } catch (fileErr) {
                console.error("❌ Erro upload:", fileErr.message);
            }

        } else {
            await axios.post(messagesUrl, {
                content: textContent, message_type: 'incoming', private: false
            }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
            console.log("✅ Texto enviado!");
        }

    } catch (error) {
        console.error("❌ Erro Geral:", error.message);
    }
});

// ROTA 2: SAÍDA (Mantida igual a v10)
app.post('/webhook/chatwoot', async (req, res) => {
    res.status(200).send('Enviando...');
    try {
        const data = req.body;
        if (data.event === 'message_created' && data.message_type === 'outgoing' && !data.private) {
            let phone = '';
            if (data.conversation?.contact_inbox?.contact) phone = data.conversation.contact_inbox.contact.phone_number;
            else if (data.conversation?.meta?.sender) phone = data.conversation.meta.sender.phone_number;

            if (!phone) return;
            phone = phone.replace(/\D/g, ''); 

            const headers = { 'Content-Type': 'application/json' };
            if (ZAPI_CLIENT_TOKEN) headers['Client-Token'] = ZAPI_CLIENT_TOKEN;

            const attachments = data.attachments;
            if (attachments && attachments.length > 0) {
                for (const attachment of attachments) {
                    const fileUrl = attachment.data_url;
                    const fileType = attachment.file_type;
                    let endpoint = '/send-document';
                    let payload = { phone: phone, document: fileUrl, extension: 'file' };

                    if (fileType === 'image') { endpoint = '/send-image'; payload = { phone, image: fileUrl, caption: data.content }; }
                    else if (fileType === 'audio') { endpoint = '/send-audio'; payload = { phone, audio: fileUrl }; }
                    else if (fileType === 'video') { endpoint = '/send-video'; payload = { phone, video: fileUrl, caption: data.content }; }

                    await axios.post(`${ZAPI_BASE_URL}${endpoint}`, payload, { headers }).catch(e => console.error(e.message));
                }
            } else if (data.content) {
                await axios.post(`${ZAPI_BASE_URL}/send-text`, { phone, message: data.content }, { headers }).catch(e => console.error(e.message));
            }
        }
    } catch (error) { console.error(error.message); }
});

app.get('/', (req, res) => res.send('Middleware v11 (Fix MIME Types) Online'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
