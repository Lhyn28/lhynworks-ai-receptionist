import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = req.body;
    console.log("📥 Incoming webhook payload:", JSON.stringify(data));
    
    const customerMessage = data.customData?.message || data.message?.body || data.message || "Hello";
    const contactId = data.customData?.id || data.contact_id || data.id;

    if (!contactId) {
      console.log("⚠️ Stopping: Missing contact ID.");
      return res.status(400).json({ error: 'Missing contact id from GHL' });
    }

    // 1. Fetch conversation history from GHL
    let formattedHistory = [];
    try {
      console.log("📜 Fetching conversation history from GHL...");
      const historyResponse = await fetch(`https://services.leadconnectorhq.com/conversations/messages?contactId=${contactId}&limit=10`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
          'Version': '2021-04-15'
        }
      });
      const historyData = await historyResponse.json();
      
      if (historyData.messages) {
        // Map GHL messages to Google Gemini format
        formattedHistory = historyData.messages.reverse().map(msg => ({
          role: msg.direction === 'inbound' ? 'user' : 'model',
          parts: [{ text: msg.body }]
        }));
      }
    } catch (e) {
      console.log("⚠️ Could not retrieve history, proceeding without it:", e.message);
    }

    // Prepare system instructions
    const systemInstruction = `You are Lhyn's AI double representing Lhynworks. You are incredibly polite, warm, and human. 
    Follow this strict sequence of rules:
    1. Greet the user with: "Hi! Good morning! How are you? I'm Lhyn, may I know your name?"
    2. After they give their name, politely ask for their email address: "Great to meet you! Can I get your email real quick? That way we can email you in case you ever need my services."
    3. Use the following knowledge base to answer questions about services and pricing:
       - About Lhyn: GoHighLevel Tech VA for Coaches & Agencies.
       - Services: Funnels & Landing Pages, Tech Setup & DNS, Workflows & CRM Management.
       - Pricing: Custom services generally start at around $250 for smaller setups and up to $1,000+ for full account overhauls. Give ballpark estimates and suggest a call.
    4. If they agree to book a call, provide your GHL calendar link directly in the chat or let them know you will reach out manually.
    5. If they say "Thank you", politely say "You're welcome!", summarize, and say goodbye.`;

    // Add current message to history if it's empty
    if (formattedHistory.length === 0) {
      formattedHistory.push({ role: 'user', parts: [{ text: customerMessage }] });
    }

    // 2. Requesting Google Gemini Direct (Massive Free Tier & Fast)
    console.log("🛰️ Sending request directly to Google Gemini...");
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: formattedHistory,
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        }
      })
    });

    const aiData = await geminiResponse.json();
    console.log("📥 Gemini response received.");
    
    if (aiData.error) throw new Error(`Gemini API Error: ${aiData.error.message}`);
    
    // Extract reply text from Google's schema
    const replyText = aiData.candidates?.[0]?.content?.parts?.[0]?.text || "Thanks for messaging! How can I help you today?";
    console.log(`💬 AI response prepared: "${replyText}"`);

    // 3. Normal conversation reply back to GHL
    console.log("📤 Sending message back to GHL conversation...");
    const ghlMessageResponse = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
        'Content-Type': 'application/json',
        'Version': '2021-04-15'
      },
      body: JSON.stringify({
        type: 'Live_Chat',
        contactId: contactId,
        message: replyText
      })
    });

    const ghlResponseData = await ghlMessageResponse.json();

    if (!ghlMessageResponse.ok) {
      throw new Error(`GHL Message API failed: ${ghlResponseData.message || JSON.stringify(ghlResponseData)}`);
    }

    console.log("🎉 Process completed successfully.");
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('🚨 Process stopped by error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
