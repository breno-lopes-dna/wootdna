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

// --- CONFIGURAÇÕES Z-API (COM LIMPEZA DE ESPAÇOS) ---
// O .trim() remove espaços em branco acidentais no início ou fim
const ZAPI_INSTANCE_ID = (process.env.ZAPI_INSTANCE_ID || "").trim();
const ZAPI_TOKEN = (process.env.ZAPI_TOKEN || "").trim();
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

        // 1. Lógica de Contato
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
            } 
            else if (data.conversation && data.conversation.meta && data.conversation.meta.sender) {
                phone = data.conversation.meta.sender.phone_number;
            }

            if (phone) {
                // Limpa o telefone para garantir formato Z-API
                phone = phone.replace(/\D/g, ''); 
                
                console.log(`📤 Tentando enviar via Z-API...`);
                console.log(`   Destino: ${phone}`);
                console.log(`   URL: ${ZAPI_URL.replace(ZAPI_TOKEN, '***')}`); // Loga URL sem mostrar token

                // Envia para Z-API e Loga a resposta
                await axios.post(ZAPI_URL, {
                    phone: phone,
                    message: content
                })
                .then(response => {
                    console.log(`✅ Z-API Respondeu: ${JSON.stringify(response.data)}`);
                })
                .catch(err => {
                    // AQUI ESTÁ O SEGREDO DO ERRO 400
                    console.error(`❌ Z-API Recusou (Erro ${err.response?.status}):`);
                    console.error(`   Motivo: ${JSON.stringify(err.response?.data)}`);
                });
            } else {
                console.log("⚠️ Telefone não encontrado no evento do Chatwoot.");
            }
        }
    } catch (error) {
        console.error("❌ Erro Geral Saída:", error.message);
    }
});

app.get('/', (req, res) => res.send('Middleware v6 (Trim + Debug Z-API) Online 🟢'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
