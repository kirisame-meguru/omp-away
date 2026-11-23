import assert from "node:assert/strict";
import { mock, spyOn } from "bun:test";
import { type as arktype } from "@oh-my-pi/omptype";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as registry from "@oh-my-pi/pi-coding-agent/config/registry";
import asyncAsk from "async-ask-under-test";
import away from "../../src/index.ts";
import * as adminModule from "../../src/runtime/index.ts";
import { connectRuntime } from "../../src/runtime/routing.ts";

// Resolve async-ask-under-test with a temporary --tsconfig-override paths entry.
// No gateway credentials, native Collab, real phone or model service is used here.
const html = '<form><label>Release lane<select name="lane" required><option value="blue">Blue</option><option value="green">Green</option></select></label></form>';
const turn = () => Bun.sleep(0);
const results = [];
for (const order of ["async-first", "away-first"]) {
  for (const scenario of ["phone", "desktop", "withdraw", "restore", "send-failure"]) {
    const events = new EventBus(), handlers = new Map(), tools = new Map();
    const journal = [], sent = [], notices = [], voice = [], controls = [];
    let sessionId = "fixture", mobile, wire, pending = [];
    const ctx = {
      cwd: process.cwd(), mode: "tui", hasUI: true, agent: {kind: "main"},
      isIdle: () => false, hasPendingMessages: () => false, setTimeout,
      sessionManager: {getSessionId: () => sessionId, getBranch: () => journal},
      modelRegistry: {},
      runEphemeralTurn: async () => { throw Error("Exact choices must not require a model"); },
      ui: {notify: text => notices.push(text), setWidget() {}, custom() {throw Error("No UI opening was requested");}},
    };
    const api = {
      events, arktype, registerCommand() {}, getActiveTools: () => [], async setActiveTools() {},
      registerTool(tool) { tools.set(tool.name, tool); },
      on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
      appendEntry(customType, data) { journal.push({type:"custom",id:crypto.randomUUID(),parentId:null,timestamp:new Date().toISOString(),customType,data}); },
      sendMessage(message, options) {
        assert.equal(options.deliverAs, "aside"); assert.equal(message.attribution, "user");
        if (scenario === "send-failure") throw Error("Fixture transport failure");
        sent.push(message);
        journal.push({type:"custom_message",id:crypto.randomUUID(),parentId:null,timestamp:new Date().toISOString(),...message});
      },
    };
    async function emit(name, event = {}) { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); }
    spyOn(registry, "lookup").mockReturnValue(undefined);
    spyOn(adminModule, "gatewayConfigured").mockReturnValue(true);
    spyOn(adminModule, "openAdmin").mockImplementation(async () => {
      mobile = await connectRuntime({url:"https://example.invalid",desktopToken:"",stateDir:"",confirmPair:async()=>false},code=>{throw Error(code)}, {
        async gateway(options) {
          wire = options; options.onRouting({away:true,delayMs:null}); options.onConnect("phone");
          return { async devices(){return ["phone"]}, async close(){}, async pair(){throw Error("No pairing")},
            async routing(){return {away:true,delayMs:null}}, async ring(){}, async sendPcm(){},
            async sendControl(_device,message){controls.push(message)},
          };
        },
        async voice(options) {
          voice.push(options);
          return {async sendSpeakable(){},async sendPcm(){},async close(){}};
        },
      });
      return {...mobile,async command(){},cancelEnrollment(){}};
    });
    const attach = () => events.emit("omp-async-ask:connect:v1", {version:1,sessionId,accept(next){next.subscribe(questions=>{pending=questions})}});
    const off = events.on("omp-async-ask:available:v1", attach);
    try {
      if (order === "async-first") { asyncAsk(api); away(api); } else { away(api); asyncAsk(api); }
      await emit("session_start"); await turn(); attach();
      const tool = tools.get("ask_async");
      const created = await tool.execute("question-tool", {op:"create",title:"Deployment decision",html,blockedWork:"Deploying"},undefined,undefined,ctx);
      assert.equal(created.isError, undefined);
      const canonicalId = created.details.id;
      let question = pending[0], old = question;
      assert.equal(question.id, canonicalId);
      let independentWork = false;
      await turn(); independentWork = true;
      await emit("agent_end", {willContinue:false});
      assert(independentWork); assert.equal(pending.length,1);
      if (scenario === "restore") {
        await emit("session_before_tree");
        assert.equal(old.submitConfirmed({lane:"blue"}).kind,"stale");
        await emit("session_tree"); await turn(); attach();
        question = pending[0];
        assert.equal(question.id, canonicalId); assert.notEqual(question.requestId,old.requestId);
      }
      if (scenario === "withdraw") {
        await tool.execute("withdraw-tool",{op:"withdraw",id:canonicalId,reason:"Fixture no longer needs it"},undefined,undefined,ctx);
        assert.equal(question.submitConfirmed({lane:"blue"}).kind,"stale");
        assert.equal(pending.length,0); assert.equal(sent.length,0);
      } else {
        const item = controls.findLast(message=>message.type==="inbox")?.items.find(item=>item.requestId===question.requestId);
        assert(item, "Question never reached the actual mobile runtime inbox");
        await wire.onMessage("phone",{type:"join",requestId:question.requestId});
        const call = voice.at(-1); assert(call);
        call.onSpeechStarted("choice"); call.onTranscript("user","Blue","choice"); await turn();
        if (scenario === "desktop") {
          const outcome = question.submitConfirmed({lane:"green"});
          assert.equal(outcome.kind,"accepted");
        }
        call.onSpeechStarted("confirmation"); call.onTranscript("user","Yes","confirmation");
        await turn(); await turn();
        call.onSpeechStarted("duplicate"); call.onTranscript("user","Yes","duplicate"); await turn();
        assert.equal(pending.length,0);
        const submitted = journal.filter(entry=>entry.type==="custom" && entry.data.kind==="submitted");
        assert.equal(submitted.length,1);
        assert.deepEqual(submitted[0].data.answer.data,{lane:scenario==="desktop"?"green":"blue"});
        assert.equal(sent.length,scenario==="send-failure"?0:1);
        if (sent.length) assert.equal(sent[0].details.answerId,submitted[0].data.answer.id);
        if (scenario==="send-failure") assert(notices.some(text=>text.includes("saved") && text.includes("/questions")));
        assert(call.signal.aborted);
      }
      const list = await tool.execute("inspect",{op:"list"},undefined,undefined,ctx);
      assert.equal(list.details.questions[0].status,scenario==="withdraw"?"withdrawn":"answered");
      results.push({order,scenario,passed:true});
    } finally {
      off(); await emit("session_shutdown"); mock.restore();
    }
  }
}
console.log(JSON.stringify({scenarios:results.length,results}));
