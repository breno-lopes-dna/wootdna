const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

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
// ROTA 1: ENTRADA (Z-API -> CHATWOOT)
// =======================================================================
app.post('/webhook/zapi', async (req, res) => {
    res.status(200).send('Webhook recebido');

    try {
        const data = req.body;
        // Ignora status de entrega e grupos
        if (data.type !== 'ReceivedCallback' || data.isGroup) return;

        const phone = data.phone;
        
        // --- 1. DETECÇÃO DE CONTEÚDO (Multimídia) ---
        let finalMessage = '';
        let attachmentUrl = ''; // Futuro: se quiser baixar e enviar nativo (não implementado aqui para leveza)

        // Prioridade: Texto > Áudio > Imagem > Documento > Vídeo
        if (data.text) {
            if (typeof data.text === 'string') finalMessage = data.text;
            else if (data.text.message) finalMessage = data.text.message;
        }

        if (!finalMessage && data.audio) {
            finalMessage = `🎤 Áudio Recebido: ${data.audio.audioUrl}`;
        }

        if (!finalMessage && data.image) {
            finalMessage = `📷 Imagem Recebida: ${data.image.imageUrl}`;
            if (data.image.caption) finalMessage += `\nLegenda: ${data.image.caption}`;
        }

        if (!finalMessage && data.video) {
            finalMessage = `🎥 Vídeo Recebido: ${data.video.videoUrl}`;
            if (data.video.caption) finalMessage += `\nLegenda: ${data.video.caption}`;
        }

        if (!finalMessage && data.document) {
            finalMessage = `📄 Documento Recebido: ${data.document.documentUrl}`;
            if (data.document.caption) finalMessage += `\nNome: ${data.document.caption}`;
        }

        if (!finalMessage && data.sticker) {
            finalMessage = `🤡 Figurinha Recebida: ${data.sticker.stickerUrl}`;
        }

        if (!finalMessage) {
            console.log(`⚠️ Tipo de mensagem desconhecido de ${phone}.`);
            return;
        }

        const senderName = data.senderName || `Cliente ${phone}`;
        let finalSourceId = null;

        // --- 2. LÓGICA DE CONTATO/CONVERSA ---
        try {
            // Tenta criar contato
            const createRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`, {
                inbox_id: CHATWOOT_INBOX_ID,
                name: senderName,
                phone_number: `+${phone}`
            }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
            finalSourceId = createRes.data.payload.contact_inbox.source_id;
        } catch (err) {
            // Se já existe, busca e vincula
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

        // Garante conversa aberta
        const convRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`, {
            source_id: finalSourceId,
            inbox_id: CHATWOOT_INBOX_ID,
            status: 'open'
        }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });

        const conversationId = convRes.data.id;

        // Envia para o Chatwoot
        await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, {
            content: finalMessage,
            message_type: 'incoming',
            private: false
        }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
        
        console.log(`📥 [Entrada] Mídia/Texto de ${phone} entregue.`);

    } catch (error) {
        console.error("❌ Erro Entrada:", error.message);
    }
});

// =======================================================================
// ROTA 2: SAÍDA (CHATWOOT -> Z-API) - COM SUPORTE A MÍDIA
// =======================================================================
app.post('/webhook/chatwoot', async (req, res) => {
    res.status(200).send('Enviando...'); 

    try {
        const data = req.body;
        
        // Filtra eventos de mensagem criada pelo atendente (outgoing) e que não seja privada
        if (data.event === 'message_created' && 
            data.message_type === 'outgoing' && 
            !data.private) {

            // --- 1. DESCOBRIR O TELEFONE ---
            let phone = '';
            if (data.conversation && data.conversation.contact_inbox && data.conversation.contact_inbox.contact) {
                 phone = data.conversation.contact_inbox.contact.phone_number;
            } else if (data.conversation && data.conversation.meta && data.conversation.meta.sender) {
                phone = data.conversation.meta.sender.phone_number;
            }

            if (!phone) {
                console.log("⚠️ Saída ignorada: Telefone não encontrado.");
                return;
            }
            phone = phone.replace(/\D/g, ''); // Limpa o número

            // --- 2. PREPARAR HEADERS ---
            const headers = { 'Content-Type': 'application/json' };
            if (ZAPI_CLIENT_TOKEN) headers['Client-Token'] = ZAPI_CLIENT_TOKEN;

            // --- 3. VERIFICAR SE TEM ANEXO (FOTO/ÁUDIO/DOC) ---
            const attachments = data.attachments;
            const contentText = data.content || "";

            if (attachments && attachments.length > 0) {
                // Loop para enviar cada anexo (geralmente é 1 por vez no Chatwoot)
                for (const attachment of attachments) {
                    const fileUrl = attachment.data_url;
                    const fileType = attachment.file_type; // 'image', 'audio', 'video', 'file'
                    
                    console.log(`📤 Enviando Anexo (${fileType}) para ${phone}...`);

                    let endpoint = '/send-document'; // Padrão
                    let payload = {
                        phone: phone,
                        document: fileUrl,
                        extension: fileUrl.split('.').pop() || "file"
                    };

                    // Ajusta endpoint e payload conforme o tipo
                    if (fileType === 'image') {
                        endpoint = '/send-image';
                        payload = { phone: phone, image: fileUrl, caption: contentText };
                    } else if (fileType === 'audio') {
                        endpoint = '/send-audio';
                        payload = { phone: phone, audio: fileUrl };
                    } else if (fileType === 'video') {
                        endpoint = '/send-video';
                        payload = { phone: phone, video: fileUrl, caption: contentText };
                    }

                    // Envia para Z-API
                    await axios.post(`${ZAPI_BASE_URL}${endpoint}`, payload, { headers: headers })
                        .then(() => console.log(`✅ Anexo (${fileType}) enviado com sucesso!`))
                        .catch(err => console.error(`❌ Erro envio anexo: ${JSON.stringify(err.response?.data)}`));
                }
            } 
            // --- 4. SE NÃO TEM ANEXO, É TEXTO PURO ---
            else if (contentText) {
                console.log(`📤 Enviando Texto para ${phone}: ${contentText}`);
                await axios.post(`${ZAPI_BASE_URL}/send-text`, {
                    phone: phone,
                    message: contentText
                }, { headers: headers })
                .then(res => console.log(`✅ Texto enviado!`))
                .catch(err => console.error(`❌ Erro envio texto: ${JSON.stringify(err.response?.data)}`));
            }
        }
    } catch (error) {
        console.error("❌ Erro Geral Saída:", error.message);
    }
});

app.get('/', (req, res) => res.send('Middleware v9 (Full Media Support) Online 🟢'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
