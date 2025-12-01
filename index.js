const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// --- CONFIGURAÇÕES E CORREÇÃO AUTOMÁTICA DE URL ---
let rawUrl = process.env.CHATWOOT_URL || "";
// 1. Remove barra no final se houver
if (rawUrl.endsWith('/')) rawUrl = rawUrl.slice(0, -1);
// 2. Corrige erro comum de digitar https:// duas vezes
rawUrl = rawUrl.replace("https://https://", "https://");
rawUrl = rawUrl.replace("http://https://", "https://");
// 3. Garante que começa com https:// se não tiver nada
if (!rawUrl.startsWith("http")) rawUrl = `https://${rawUrl}`;

const CHATWOOT_URL = rawUrl;
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || 1;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || 1;

// --- ROTA DO WEBHOOK ---
app.post('/webhook/zapi', async (req, res) => {
    res.status(200).send('Webhook recebido');

    try {
        const data = req.body;
        console.log("📥 [1] Payload recebido:", JSON.stringify(data));

        if (data.type === 'ReceivedCallback' && !data.isGroup) {
            
            const phone = data.phone;
            
            // Tratamento robusto para o texto (seja string ou objeto)
            let text = '';
            if (typeof data.text === 'string') {
                text = data.text;
            } else if (data.text && data.text.message) {
                text = data.text.message;
            }

            if (!text) {
                console.log("⚠️ [2] Ignorado: Mensagem sem texto.");
                return;
            }

            const senderName = data.senderName || `Cliente ${phone}`;
            
            console.log(`🔄 [3] Processando msg de: ${senderName}`);
            // Aqui vamos ver a URL corrigida no log
            console.log(`🔗 [Info] URL Corrigida: ${CHATWOOT_URL}`); 

            // --- BUSCAR CONTATO ---
            let contactId;
            const searchUrl = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${phone}`;
            
            try {
                const searchRes = await axios.get(searchUrl, { 
                    headers: { 'api_access_token': CHATWOOT_TOKEN } 
                });
                
                if (searchRes.data.payload && searchRes.data.payload.length > 0) {
                    contactId = searchRes.data.payload[0].id;
                    console.log(`✅ [4] Contato encontrado: ID ${contactId}`);
                } else {
                    console.log("🆕 [4] Criando novo contato...");
                    // Aqui adicionamos o + manualmente no telefone
                    const createContactRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`, {
                        inbox_id: CHATWOOT_INBOX_ID,
                        name: senderName,
                        phone_number: `+${phone}` 
                    }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
                    
                    contactId = createContactRes.data.payload.contact.id;
                    console.log(`✅ [4] Contato criado: ID ${contactId}`);
                }

                // --- GARANTIR CONVERSA ---
                const convRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`, {
                    source_id: contactId,
                    inbox_id: CHATWOOT_INBOX_ID,
                    status: 'open'
                }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });

                const conversationId = convRes.data.id;
                console.log(`💬 [5] Conversa ID: ${conversationId}`);

                // --- ENVIAR MENSAGEM ---
                await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, {
                    content: text,
                    message_type: 'incoming',
                    private: false
                }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
                
                console.log("🎉 [6] SUCESSO! Mensagem no Chatwoot.");

            } catch (apiError) {
                console.error("❌ ERRO AXIOS:");
                // Log detalhado para sabermos se é 404 (URL errada) ou 401 (Senha errada)
                if (apiError.code) console.error(`Código: ${apiError.code}`);
                if (apiError.response) {
                    console.error(`Status HTTP: ${apiError.response.status}`);
                    console.error(`Msg do Chatwoot: ${JSON.stringify(apiError.response.data)}`);
                }
            }
        }

    } catch (error) {
        console.error("❌ Erro Geral:", error.message);
    }
});

app.get('/', (req, res) => res.send('Middleware Z-API v3 (URL Blindada) Online'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
