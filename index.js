const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// --- CONFIGURAÇÕES (Vêm das Variáveis de Ambiente do Coolify) ---
const CHATWOOT_URL = process.env.CHATWOOT_URL; // Ex: http://chatwoot:3000 ou https://seu-site.com
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || 1;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || 1;

// --- ROTA DO WEBHOOK (Z-API) ---
app.post('/webhook/zapi', async (req, res) => {
    // [IMPORTANTE] Responde imediatamente para a Z-API não dar erro de timeout
    res.status(200).send('Webhook recebido com sucesso');

    // O processamento acontece em segundo plano (Assíncrono)
    try {
        const data = req.body;

        // Log para debug no Coolify
        console.log("📥 Payload recebido da Z-API:", JSON.stringify(data));

        // Filtro: Processa apenas mensagens de texto recebidas (ReceivedCallback)
        // Ignora mensagens de grupos (!data.isGroup)
        if (data.type === 'ReceivedCallback' && !data.isGroup) {
            
            const phone = data.phone; 
            const text = data.text;
            // Se não vier nome, usa o telefone como nome
            const senderName = data.senderName || `Cliente ${phone}`;

            // Validação de segurança
            if (!phone || !text) {
                console.log("⚠️ Mensagem ignorada: Telefone ou texto vazios.");
                return;
            }

            console.log(`🔄 Processando mensagem de: ${senderName} (${phone})`);

            // --- PASSO 1: Buscar Contato no Chatwoot ---
            let contactId;
            const searchUrl = `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${phone}`;
            
            try {
                const searchRes = await axios.get(searchUrl, { 
                    headers: { 'api_access_token': CHATWOOT_TOKEN } 
                });
                
                if (searchRes.data.payload && searchRes.data.payload.length > 0) {
                    contactId = searchRes.data.payload[0].id;
                    console.log(`✅ Contato existente encontrado (ID: ${contactId})`);
                } else {
                    // --- PASSO 2: Criar Contato se não existir ---
                    console.log("🆕 Criando novo contato...");
                    const createContactRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`, {
                        inbox_id: CHATWOOT_INBOX_ID,
                        name: senderName,
                        phone_number: `+${phone}`
                    }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
                    
                    contactId = createContactRes.data.payload.contact.id;
                    console.log(`✅ Novo contato criado (ID: ${contactId})`);
                }

                // --- PASSO 3: Garantir Conversa Aberta ---
                // Cria ou recupera conversa existente
                const convRes = await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`, {
                    source_id: contactId,
                    inbox_id: CHATWOOT_INBOX_ID,
                    status: 'open'
                }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });

                const conversationId = convRes.data.id;
                console.log(`💬 ID da Conversa: ${conversationId}`);

                // --- PASSO 4: Enviar a Mensagem ---
                await axios.post(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, {
                    content: text,
                    message_type: 'incoming', // Define que é mensagem de ENTRADA (cliente)
                    private: false
                }, { headers: { 'api_access_token': CHATWOOT_TOKEN } });
                
                console.log("🚀 SUCESSO: Mensagem entregue ao Chatwoot!");

            } catch (apiError) {
                console.error("❌ Erro na API do Chatwoot:", apiError.response?.data || apiError.message);
            }
        } else {
            // Logs para entender o que está sendo ignorado (ex: status de entrega, grupos)
            console.log(`ℹ️ Evento ignorado (Tipo: ${data.type}, Grupo: ${data.isGroup})`);
        }

    } catch (error) {
        console.error("❌ Erro crítico no servidor:", error.message);
    }
});

// Rota de saúde para testar no navegador
app.get('/', (req, res) => {
    res.send('<h3>Middleware Z-API > Chatwoot está ONLINE e CORRIGIDO! 🟢</h3>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
