const $ = selector => document.querySelector(selector);
const form = $("#invoiceForm");
const presets = {
  nova:{clientName:"Nova Studio",invoiceNumber:"INV-2048",amount:2450,daysOverdue:32,history:"late",relationship:"repeat",notes:"The launch went well. They mentioned a short procurement delay last week."},
  orbit:{clientName:"Orbit Labs",invoiceNumber:"INV-2029",amount:7800,daysOverdue:61,history:"late",relationship:"new",notes:"Two follow-ups have gone unanswered. The delivered analytics system is in production."},
  moss:{clientName:"Moss & Co.",invoiceNumber:"INV-2056",amount:960,daysOverdue:8,history:"reliable",relationship:"long-term",notes:"A trusted client for three years. Their finance lead is on leave."}
};
let currentInput;

const values = () => ({
  clientName: $("#clientName").value.trim(), invoiceNumber: $("#invoiceNumber").value.trim(),
  amount: Number($("#amount").value), currency: $("#currency").value,
  daysOverdue: Number($("#daysOverdue").value), history: $("#history").value,
  relationship: $("#relationship").value, notes: $("#notes").value.trim()
});

const show = id => ["#emptyState","#loadingState","#results"].forEach(x => $(x).classList.toggle("hidden", x !== id));
const toast = text => { $("#toast").textContent=text; $("#toast").classList.add("show"); setTimeout(()=>$("#toast").classList.remove("show"),2200); };

async function analyze() {
  currentInput = values();
  show("#loadingState");
  try {
    const response = await fetch("/api/analyze",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(currentInput)});
    const data = await response.json();
    if(!response.ok) throw new Error(data.error);
    $("#risk").textContent=data.risk;
    $("#riskRing").style.background=`conic-gradient(${data.risk>=70?"#ef785f":"#7258e8"} ${data.risk}%,#eee 0)`;
    $("#approach").textContent=`${data.tone[0].toUpperCase()+data.tone.slice(1)} · ${data.plans.length>1?"Flexible plan":"Full payment"}`;
    $("#reason").textContent=data.reason; $("#confidence").textContent=`${data.confidence}%`;
    $("#nextAction").textContent=data.nextAction; $("#subject").value=data.subject; $("#message").value=data.message;
    $("#plans").innerHTML=data.plans.map(p=>`<div class="plan-line"><span>${p.label}</span><b>${new Intl.NumberFormat("en",{style:"currency",currency:currentInput.currency}).format(p.amount)}</b><b>${p.percentage}%</b></div>`).join("");
    show("#results");
  } catch(error) { show("#emptyState"); toast(error.message || "Could not build plan"); }
}

form.addEventListener("submit",e=>{e.preventDefault();analyze()});
document.addEventListener("keydown",e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter") analyze()});
document.querySelectorAll(".invoice").forEach(button=>button.addEventListener("click",()=>{
  document.querySelectorAll(".invoice").forEach(x=>x.classList.remove("active")); button.classList.add("active");
  Object.entries(presets[button.dataset.preset]).forEach(([key,value])=>$("#"+key).value=value); show("#emptyState");
}));
$("#copyBtn").addEventListener("click",async()=>{await navigator.clipboard.writeText(`Subject: ${$("#subject").value}\n\n${$("#message").value}`);toast("Message copied");});
$("#paypalBtn").addEventListener("click",async()=>{
  const button=$("#paypalBtn"); button.disabled=true; button.textContent="Creating secure checkout…";
  try{const response=await fetch("/api/paypal/orders",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...currentInput,origin:location.origin})});const order=await response.json();if(!response.ok)throw new Error(order.error);if(order.approveUrl)location.href=order.approveUrl;else toast(`Demo order ${order.id} created — add PayPal keys for checkout`);}catch(error){toast(error.message)}finally{button.disabled=false;button.innerHTML='<span class="pp">P</span> Create secure PayPal checkout';}
});
$("#tourBtn").addEventListener("click",()=>$("#tour").showModal()); $("#closeTour").addEventListener("click",()=>$("#tour").close());

fetch("/api/health").then(r=>r.json()).then(s=>{if(s.paypal){$("#status").classList.add("live");$("#status").innerHTML="<i></i> PayPal Sandbox live";}});
const returnParams=new URLSearchParams(location.search);
if(returnParams.has("paid")&&returnParams.get("token")){
  fetch("/api/paypal/capture",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({orderId:returnParams.get("token")})})
    .then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error);toast("Payment captured successfully in PayPal Sandbox");history.replaceState({},"","/");})
    .catch(error=>toast(error.message||"Payment approval received; capture needs attention"));
}
