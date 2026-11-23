import { expect, test } from "bun:test";
import { prepare } from "../src/decisions/form";
import { questionDisplay } from "../src/decisions/display";
import { tagForm } from "../src/collab/form";
import { DecisionCoordinator } from "../src/decisions";

const html='<form><input type="hidden" name="capability" value="hidden-secret"><fieldset><legend>Deployment</legend><p>Choose a region carefully.</p><label>Target<select name="internal-target" required multiple><option value="secret-a">Same</option><option value="secret-b">Same</option><option value="secret-c" disabled>Unavailable</option></select></label><p>Explain your constraints.</p><label>Notes<textarea name="internal-notes" placeholder="Optional notes" maxlength="200"></textarea></label></fieldset></form>';
test("parsed fields retain grouping, duplicates, disabled choices and constraints without submission identities",()=>{
 const display=prepare(html)?.display;
 expect(display?.v).toBe(1);
 expect(display?.fields[0]).toMatchObject({id:"f1",label:"Target",kind:"multi",required:true,options:[{id:"o1",label:"Same",disabled:false},{id:"o2",label:"Same",disabled:false},{id:"o3",label:"Unavailable",disabled:true}]});
 expect(display?.fields[0].description).toContain("Deployment");
 expect(display?.fields[0].description).toContain("Choose a region carefully.");
 expect(display?.fields[1]).toMatchObject({id:"f2",label:"Notes",kind:"text",required:false,inputType:"textarea",placeholder:"Optional notes"});
 expect(display?.fields[1].description).toContain("200");
 const wire=JSON.stringify(display);
 for(const secret of ["hidden-secret","capability","internal-target","internal-notes","secret-a","secret-b","secret-c"]) expect(wire).not.toContain(secret);
});
test("native radio Other and optional unavailable fields are represented without invented choices",()=>{
 const form=tagForm('<form><p>Which drink?</p><label><input type="radio" name="drink" value="t">Tea</label><label><input type="radio" name="drink" value="c">Coffee</label><label>Retired<select name="retired"><option value="hidden-value" disabled>Old</option></select></label></form>')!;
 const display=questionDisplay(form.parsed)!;
 expect(display.fields[0]).toMatchObject({id:"f1",label:"Which drink?",kind:"single",other:true,options:[{label:"Tea"},{label:"Coffee"}]});
 expect(display.fields[1]).toMatchObject({id:"f2",options:[{label:"Old",disabled:true}]});
});
test("display bounds reject the whole metadata object instead of truncating choices",()=>{
 const make=(body:string)=>tagForm(`<form>${body}</form>`)!.parsed;
 expect(questionDisplay(make('<label>'+"界".repeat(8193)+'<input name="x"></label>'))).toBeUndefined();
 expect(questionDisplay(make('<label>Options<select name="x">'+Array.from({length:257},(_,i)=>`<option value="v${i}">Option ${i}</option>`).join("")+'</select></label>'))).toBeUndefined();
 expect(questionDisplay(make(Array.from({length:33},(_,i)=>`<label>Field ${i}<input name="f${i}"></label>`).join("")))).toBeUndefined();
 const large=make(Array.from({length:8},(_,i)=>`<label>${"界".repeat(3000)}<input name="f${i}"></label>`).join(""));
 expect(questionDisplay(large)).toBeUndefined();
});
test("async display and excerpt use the form, not contextual title or capability fields",()=>{
 const native=prepare(html)!;
 const asyncForm=prepare(html,{title:"Async routing title",blockedWork:"Internal context"})!;
 expect(asyncForm.display).toEqual(native.display);
 expect(asyncForm.question).toBe("Target; Notes");
 expect(JSON.stringify(asyncForm.display)).not.toContain("Async routing title");
});
test("visual questions survive stricter voice budgets without enabling oversized voice calls",()=>{
 const html='<form><label>Choose<select name="x"><option value="a">'+"A".repeat(4500)+'</option><option value="b">'+"B".repeat(4500)+'</option></select></label></form>';
 const form=prepare(html)!;
 expect(form.display?.fields[0].options?.map(option=>option.label.length)).toEqual([4500,4500]);
 const core=new DecisionCoordinator({invite(){}});
 try {
  expect(core.offer({requestId:"large",toolCallId:"large",html,async submitConfirmed(){throw Error("No submission")}}, {async runEphemeralTurn(){throw Error("No voice")}},"Example")).toBe(true);
  expect(core.list()).toMatchObject([{requestId:"large",question:"Choose"}]);
  expect(core.join("large")).toBeUndefined();
 } finally {core.close()}
});
test("oversized metadata leaves an authoritative summary rather than dropping the request",()=>{
 const html='<form>'+Array.from({length:33},(_,i)=>`<label>Question ${i}<input name="f${i}"></label>`).join("")+'</form>';
 const core=new DecisionCoordinator({invite(){}});
 try {
  expect(core.offer({requestId:"summary",toolCallId:"summary",html,async submitConfirmed(){throw Error("No submission")}}, {async runEphemeralTurn(){throw Error("No voice")}},"Example")).toBe(true);
  expect(core.display("summary")).toBeUndefined();
  expect(core.list()[0].question).toStartWith("Question 0");
 } finally {core.close()}
});
test("bounded previews do not split astral Unicode at the encrypted frame boundary",()=>{
 const form=prepare('<form><label>'+"Q".repeat(255)+'🌍<input name="answer"></label></form>')!;
 expect(form.question).toBe("Q".repeat(255));
 expect(form.display?.fields[0].label).toBe("Q".repeat(255)+"🌍");
});
