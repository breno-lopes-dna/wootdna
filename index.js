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
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;

// =======================================================================
// ROTA 1: ENTRADA (Z-API -> CHATWOOT)
// =======================================================================
app.post('/webhook/zapi', async (req, res) => {
    res.status(200).send('Webhook recebido');

    try {
        const data = req.body;
        if (data.type !== 'ReceivedCallback' || data.isGroup) return;

        const phone = data.phone;
        let text = '';
        if (typeof data.text === 'string') text = data.text;
        else if (data.text && data.text.message) text = data.text.message;

        if (!text) return;

        const senderName = data.senderName || `Cliente ${phone}`;
        let finalSourceId = null;

        // 1. Lógica de Contato (Busca ou Cria)
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

        // 2. Conversa e Mensagem
        const convRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`, {
            source_id: finalSourceId,
            inbox_id: CHATWOOT_INBOX_ID,
            status: 'open'
        }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });

        const conversationId = convRes.data.id;

        await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, {
            content: text,
            message_type: 'incoming',
            private: false
        }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
        
        console.log(`📥 Recebido de ${phone}: ${text}`);

    } catch (error) {
        console.error("❌ Erro Entrada:", error.message);
    }
});

// =======================================================================
// ROTA 2: SAÍDA (CHATWOOT -> Z-API)
// =======================================================================
app.post('/webhook/chatwoot', async (req, res) => {
    res.status(200).send('Enviando...'); // Chatwoot espera 200 rápido

    try {
        const data = req.body;
        
        // Verifica se é uma mensagem criada, se é de saída (outgoing) e se não é privada (nota interna)
        if (data.event === 'message_created' && 
            data.message_type === 'outgoing' && 
            !data.private) {

            const content = data.content;
            
            // O Chatwoot manda o telefone do contato dentro de 'conversation' -> 'meta' -> 'sender'
            // OU dentro de 'contact' -> 'phone_number'
            // Vamos tentar pegar de forma segura
            let phone = '';
            
            // Tenta pegar do contato direto
            if (data.conversation && data.conversation.contact_inbox && data.conversation.contact_inbox.contact) {
                 phone = data.conversation.contact_inbox.contact.phone_number;
            } 
            // Fallback: tenta pegar da meta da conversa
            else if (data.conversation && data.conversation.meta && data.conversation.meta.sender) {
                phone = data.conversation.meta.sender.phone_number;
            }

            // Limpa o telefone (remove o + e caracteres especiais para a Z-API)
            if (phone) {
                phone = phone.replace(/\D/g, ''); // Remove tudo que não é número
                
                console.log(`📤 Enviando para ${phone}: ${content}`);

                // Envia para Z-API
                await axios.post(ZAPI_URL, {
                    phone: phone,
                    message: content
                });
            } else {
                console.log("⚠️ Tentativa de envio sem telefone detectado.");
            }
        }
    } catch (error) {
        console.error("❌ Erro Saída:", error.message);
    }
});

app.get('/', (req, res) => res.send('Middleware Completo (Entrada + Saída) Online 🟢'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
