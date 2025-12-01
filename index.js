const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// --- CONFIGURAÇÕES E CORREÇÃO AUTOMÁTICA DE URL ---
let rawUrl = process.env.CHATWOOT_URL || "";
if (rawUrl.endsWith('/')) rawUrl = rawUrl.slice(0, -1);
rawUrl = rawUrl.replace("https://https://", "https://");
rawUrl = rawUrl.replace("http://https://", "https://");
if (!rawUrl.startsWith("http")) rawUrl = `https://${rawUrl}`;

const CHATWOOT_URL = rawUrl;
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || 1;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || 1;

app.post('/webhook/zapi', async (req, res) => {
    res.status(200).send('Webhook recebido');

    try {
        const data = req.body;
        
        // Validações iniciais
        if (data.type !== 'ReceivedCallback' || data.isGroup) return;

        const phone = data.phone;
        let text = '';
        if (typeof data.text === 'string') text = data.text;
        else if (data.text && data.text.message) text = data.text.message;

        if (!text) return;

        const senderName = data.senderName || `Cliente ${phone}`;
        console.log(`🔄 Processando msg de: ${senderName}`);

        // --- VARIÁVEL MÁGICA: O Source ID ---
        let finalSourceId = null;

        // 1. Tentar CRIAR o contato direto (O Chatwoot lida com duplicados)
        // Isso garante que pegamos o contact_inbox correto
        try {
            console.log("🔍 Buscando/Criando contato...");
            const createRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`, {
                inbox_id: CHATWOOT_INBOX_ID,
                name: senderName,
                phone_number: `+${phone}`
            }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });

            // [CORREÇÃO]: Pegamos o source_id do contact_inbox, não o ID global
            finalSourceId = createRes.data.payload.contact_inbox.source_id;
            console.log(`✅ Contato identificado. Source ID: ${finalSourceId}`);

        } catch (err) {
            // Se der erro 422, é porque o contato já existe mas talvez não nessa caixa.
            // Vamos tentar buscar.
            if (err.response && err.response.status === 422) {
                console.log("⚠️ Contato já existe. Buscando dados...");
                const searchRes = await axios.get(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${phone}`, { 
                    headers: { 'api_access_token': CHATWOOT_TOKEN } 
                });

                if (searchRes.data.payload.length > 0) {
                    const contact = searchRes.data.payload[0];
                    // Procura se ele já tem vinculo com essa caixa
                    const inboxLink = contact.contact_inboxes.find(i => i.inbox_id == CHATWOOT_INBOX_ID);
                    
                    if (inboxLink) {
                        finalSourceId = inboxLink.source_id;
                        console.log(`✅ Vínculo existente encontrado: ${finalSourceId}`);
                    } else {
                        // Existe o contato, mas não nessa caixa. Vamos criar o vínculo.
                        console.log("➕ Criando vínculo com a caixa...");
                        const linkRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`, {
                            inbox_id: CHATWOOT_INBOX_ID,
                            name: senderName,
                            phone_number: `+${phone}`
                        }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
                        finalSourceId = linkRes.data.payload.contact_inbox.source_id;
                    }
                }
            } else {
                console.error("❌ Erro ao criar contato:", err.message);
                return;
            }
        }

        if (!finalSourceId) {
            console.error("❌ Falha crítica: Não consegui obter o Source ID.");
            return;
        }

        // 2. Criar a Conversa usando o Source ID correto
        console.log(`💬 Criando conversa...`);
        const convRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`, {
            source_id: finalSourceId, // <--- AQUI ESTAVA O PROBLEMA ANTES
            inbox_id: CHATWOOT_INBOX_ID,
            status: 'open'
        }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });

        const conversationId = convRes.data.id;
        console.log(`📝 Conversa criada: ID ${conversationId}`);

        // 3. Enviar a Mensagem
        await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, {
            content: text,
            message_type: 'incoming',
            private: false
        }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
        
        console.log("🚀 SUCESSO! Mensagem entregue.");

    } catch (error) {
        console.error("❌ Erro Geral:", error.response?.data || error.message);
    }
});

app.get('/', (req, res) => res.send('Middleware v4 (Source ID Fix) Online'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
