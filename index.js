const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const FormData = require('form-data'); // Biblioteca necessária para upload

const app = express();
app.use(bodyParser.json());

// --- CONFIGURAÇÕES CHATWOOT ---
let rawUrl = process.env.CHATWOOT_URL || "";
if (rawUrl.endsWith('/')) rawUrl = rawUrl.slice(0, -1);
rawUrl = rawUrl.replace("https://https://", "https://");
rawUrl = rawUrl.replace("http://https://", "https://");
if (!rawUrl.startsWith("http")) rawUrl = `https://${rawUrl}`;

const CHATWOOT_URL = rawUrl;
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || 1;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || 1;

// --- CONFIGURAÇÕES Z-API ---
const ZAPI_INSTANCE_ID = (process.env.ZAPI_INSTANCE_ID || "").trim();
const ZAPI_TOKEN = (process.env.ZAPI_TOKEN || "").trim();
const ZAPI_CLIENT_TOKEN = (process.env.ZAPI_CLIENT_TOKEN || "").trim();
const ZAPI_BASE_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

// =======================================================================
// ROTA 1: ENTRADA (Z-API -> CHATWOOT) - COM UPLOAD REAL
// =======================================================================
app.post('/webhook/zapi', async (req, res) => {
    res.status(200).send('Webhook recebido');

    try {
        const data = req.body;
        if (data.type !== 'ReceivedCallback' || data.isGroup) return;

        const phone = data.phone;
        const senderName = data.senderName || `Cliente ${phone}`;
        
        // Variáveis para processamento
        let textContent = '';
        let attachmentUrl = null;
        let attachmentName = 'file';

        // 1. Detectar Tipo de Conteúdo
        if (data.text) {
            textContent = (typeof data.text === 'string') ? data.text : data.text.message;
        } 
        else if (data.audio) {
            attachmentUrl = data.audio.audioUrl;
            attachmentName = 'audio.ogg'; // WhatsApp usa OGG/Opus geralmente
            textContent = ''; // Chatwoot aceita anexo sem texto
        } 
        else if (data.image) {
            attachmentUrl = data.image.imageUrl;
            attachmentName = 'image.jpeg';
            textContent = data.image.caption || '';
        } 
        else if (data.document) {
            attachmentUrl = data.document.documentUrl;
            attachmentName = data.document.fileName || 'document.pdf';
            textContent = data.document.caption || '';
        }
        else if (data.video) {
            attachmentUrl = data.video.videoUrl;
            attachmentName = 'video.mp4';
            textContent = data.video.caption || '';
        }

        // Se não tiver nem texto nem anexo, ignora
        if (!textContent && !attachmentUrl) return;

        console.log(`🔄 Processando mensagem de ${senderName}...`);

        let finalSourceId = null;

        // 2. Lógica de Contato (Busca ou Cria)
        try {
            const createRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`, {
                inbox_id: CHATWOOT_INBOX_ID,
                name: senderName,
                phone_number: `+${phone}`
            }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
            finalSourceId = createRes.data.payload.contact_inbox.source_id;
        } catch (err) {
            if (err.response && (err.response.status === 422 || err.response.data?.message?.includes('taken'))) {
                const searchRes = await axios.get(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${phone}`, { 
                    headers: { 'api_access_token': CHATWOOT_TOKEN } 
                });
                if (searchRes.data.payload.length > 0) {
                    const contact = searchRes.data.payload[0];
                    const inboxLink = contact.contact_inboxes.find(i => i.inbox_id == CHATWOOT_INBOX_ID);
                    if (inboxLink) {
                        finalSourceId = inboxLink.source_id;
                    } else {
                        const linkRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/${contact.id}/contact_inboxes`, {
                            inbox_id: CHATWOOT_INBOX_ID
                        }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
                        finalSourceId = linkRes.data.source_id;
                    }
                }
            }
        }

        if (!finalSourceId) return;

        // 3. Garantir Conversa
        const convRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`, {
            source_id: finalSourceId,
            inbox_id: CHATWOOT_INBOX_ID,
            status: 'open'
        }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });

        const conversationId = convRes.data.id;

        // 4. Enviar Mensagem (Com ou Sem Anexo)
        const messagesUrl = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;

        if (attachmentUrl) {
            // --- MODO UPLOAD (Download da Z-API -> Upload Chatwoot) ---
            console.log(`📥 Baixando arquivo: ${attachmentUrl}`);
            
            try {
                // Baixa o arquivo como stream
                const fileResponse = await axios.get(attachmentUrl, { responseType: 'stream' });
                
                // Prepara o formulário Multipart
                const form = new FormData();
                form.append('content', textContent);
                form.append('message_type', 'incoming');
                form.append('private', 'false');
                form.append('attachments[]', fileResponse.data, attachmentName);

                // Envia para o Chatwoot com os headers corretos do form-data
                await axios.post(messagesUrl, form, {
                    headers: {
                        'api_access_token': CHATWOOT_TOKEN,
                        ...form.getHeaders()
                    }
                });
                console.log("✅ Arquivo enviado para o Chatwoot!");

            } catch (fileErr) {
                console.error("❌ Erro ao baixar/enviar arquivo:", fileErr.message);
            }

        } else {
            // --- MODO TEXTO SIMPLES ---
            await axios.post(messagesUrl, {
                content: textContent,
                message_type: 'incoming',
                private: false
            }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
            console.log("✅ Texto enviado para o Chatwoot!");
        }

    } catch (error) {
        console.error("❌ Erro Geral:", error.message);
    }
});

// =======================================================================
// ROTA 2: SAÍDA (CHATWOOT -> Z-API) - MANTIDA IGUAL A V9
// =======================================================================
app.post('/webhook/chatwoot', async (req, res) => {
    res.status(200).send('Enviando...'); 

    try {
        const data = req.body;
        
        if (data.event === 'message_created' && 
            data.message_type === 'outgoing' && 
            !data.private) {

            const content = data.content;
            let phone = '';
            
            if (data.conversation && data.conversation.contact_inbox && data.conversation.contact_inbox.contact) {
                 phone = data.conversation.contact_inbox.contact.phone_number;
            } else if (data.conversation && data.conversation.meta && data.conversation.meta.sender) {
                phone = data.conversation.meta.sender.phone_number;
            }

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

                    if (fileType === 'image') {
                        endpoint = '/send-image';
                        payload = { phone: phone, image: fileUrl, caption: content };
                    } else if (fileType === 'audio') {
                        endpoint = '/send-audio';
                        payload = { phone: phone, audio: fileUrl };
                    } else if (fileType === 'video') {
                        endpoint = '/send-video';
                        payload = { phone: phone, video: fileUrl, caption: content };
                    }

                    await axios.post(`${ZAPI_BASE_URL}${endpoint}`, payload, { headers: headers })
                        .catch(err => console.error(`❌ Z-API Erro Anexo: ${JSON.stringify(err.response?.data)}`));
                }
            } 
            else if (content) {
                await axios.post(`${ZAPI_BASE_URL}/send-text`, {
                    phone: phone,
                    message: content
                }, { headers: headers })
                .catch(err => console.error(`❌ Z-API Erro Texto: ${JSON.stringify(err.response?.data)}`));
            }
        }
    } catch (error) {
        console.error("❌ Erro Saída:", error.message);
    }
});

app.get('/', (req, res) => res.send('Middleware v10 (Native Attachments) Online 🟢'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
