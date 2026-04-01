import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = req.body;
    
    // Fallbacks to capture incoming data no matter how GHL decides to send it
    const customerMessage = data.message?.body || data.text || data.message;
    const contactId = data.contact?.id || data.contactId || data.user_id;

    if (!customerMessage || !contactId) {
      console.log("⚠️ Missing data from GHL. Received body:", data);
      return res.status(400).json({ error: 'Missing data from GHL' });
    }

    // 1. Requesting OpenRouter
    const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        // Specific model call to prevent OpenRouter from routing to broken free tiers
        model: 'mistralai/mistral-7b-instruct:free', 
        messages: [
          {
            role: 'system',
            content: `You are Lhyn's AI double representing Lhynworks. Warm and human.
            Strict Sequence:
            1. Greet them and ask for their name.
            2. Politely ask for their email.
            3. Once you have both name and email, you MUST use the 'upsertContact' function to save their data.
            4. Answer questions using the knowledge base.
            5. Suggest a discovery call and use 'bookAndAlert' function if they agree.`
          },
          { role: 'user', content: customerMessage }
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "upsertContact",
              description: "Saves the guest's name and email in GHL.",
              parameters: {
                type: "object",
                properties: {
                  firstName: { type: "string" },
                  email: { type: "string" }
                },
                required: ["email", "firstName"]
              }
            }
          },
          {
            type: "function",
            function: {
              name: "bookAndAlert",
              description: "Saves their specific problem and books them on the calendar.",
              parameters: {
                type: "object",
                properties: {
                  clientProblem: { type: "string", description: "A quick summary of what the client needs help with." },
                  startTime: { type: "string", description: "ISO 8601 format date time for the appointment." }
                },
                required: ["clientProblem", "startTime"]
              }
            }
          }
        ],
        tool_choice: "auto"
      })
    });

    const aiData = await openRouterResponse.json();
    
    if (!aiData.choices || aiData.choices.length === 0) {
       throw new Error("OpenRouter did not return any choices. Check API Key or Quota.");
    }
    
    const responseMessage = aiData.choices[0].message;

    // 2. Executing Function Calls (GHL Automations)
    if (responseMessage.tool_calls) {
      const toolCall = responseMessage.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments);

      if (toolCall.function.name === "upsertContact") {
        await fetch('https://services.leadconnectorhq.com/contacts/', { // Fixed endpoint for standard GHL v2
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          },
          body: JSON.stringify({
            locationId: process.env.GHL_LOCATION_ID,
            firstName: args.firstName,
            email: args.email
          })
        });

        return res.status(200).json({ success: true, reply: `Perfect, I've got you in the system, ${args.firstName}! How can I help you today?` });
      }

      if (toolCall.function.name === "bookAndAlert") {
         // (Keep your original bookAndAlert fetch requests here)
      }
    }

    // 3. Normal conversation reply fallback (Fixed fallbacks in case content is null)
    const replyText = responseMessage.content || "Thanks for messaging! How can I help you today?";

    await fetch('https://services.leadconnectorhq.com/conversations/messages', {
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

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
