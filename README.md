# MEMORY-CAMPANION
Alexa+ dementia care
Memory Companion is an Alexa+ MCP server that brings calm to dementia care. When a patient repeats a question, says “I want to go home,” or asks for a loved one, it guides a warm reply that never corrects or argues. It guards medication by blocking double doses and flagging missed ones, and it logs every pattern. Caregivers get a live dashboard and a plain-language weekly report showing what changed and when, such as evening restlessness. Patients get patience, and families get clarity. It’s a prototype, not a medical device, and needs no Alexa hardware.


To run it (Node.js required):npm install DANGEROUSLY_OMIT_AUTH=true npx @modelcontextprotocol/inspector node index.js
Then open a second terminal in the same folder and run:node dashboard-server.js
Open http://localhost:3000 in a browser. Click Show sample week to see a full dashboard without entering any data first.
