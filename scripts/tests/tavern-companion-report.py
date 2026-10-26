"""Materialize completed benchmark evidence into a single local Canvas."""
import json
from pathlib import Path
import sys


def main():
    root = Path(sys.argv[1]).resolve()
    destination = Path(sys.argv[2])
    runs = []
    for path in sorted(root.glob("*/result.json")):
        result = json.loads(path.read_text(encoding="utf-8"))
        requests = []
        for request in result["requests"]:
            requests.append({k: request.get(k) for k in (
                "id", "visible", "first_visible_s", "wall_s", "tokens_predicted", "stopped_limit",
                "input_tokens", "recall_pass", "recall_checks", "timings")})
            requests[-1].update(user=request.get("messages", [{}])[-1].get("content", ""),
                                path=str(path.parent / (request["id"] + ".json")))
        runs.append({k: result.get(k) for k in (
            "label", "model", "context", "cache", "cpu_ffn", "seed", "sampler", "card_format", "status", "peaks", "failures")})
        runs[-1].update(requests=requests, path=str(path), diagnostic="diagnostic" in path.parent.name)
    data = {"runs": runs, "assessment": json.loads((root / "assessment.json").read_text(encoding="utf-8")),
            "hardware": json.loads((root / "hardware.json").read_text(encoding="utf-8")),
            "manifest": json.loads((root / "manifest.json").read_text(encoding="utf-8"))}
    (root / "summary.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    template = r'''import { Stack, Row, Grid, H1, H2, H3, Text, Table, BarChart, Pill, Button, Callout, useCanvasState, useCanvasAction, useHostTheme } from "cursor/canvas";
type Request = {id:string; visible:string; user:string; path:string; first_visible_s:number|null; wall_s:number; tokens_predicted:number; stopped_limit:boolean; input_tokens?:number; recall_pass?:number; recall_checks?:Record<string,boolean>; timings:{predicted_per_second:number;prompt_per_second:number}};
type Run = {label:string; model:{id:string;repo:string;file:string;revision:string;sha256:string};context:number;cache:string;cpu_ffn:number;seed:number;sampler:Record<string,number>;card_format?:string;status:string;diagnostic:boolean;path:string;peaks:{gpu_dedicated_mib:number;gpu_shared_mib:number;rss_mib:number;private_commit_mib:number};requests:Request[];failures:string[]};
const DATA = __DATA__;
const RUNS = DATA.runs as unknown as Run[];
const NAMES:Record<string,string> = {minifantasy:"MiniFantasy 4B Q5",sbg9b:"硅基女友 v2 9B Q4",huihui4b:"Huihui 4B Q5"};
const name=(r:Run)=>NAMES[r.model.id]+" · "+r.context/1024+"K"+(r.cpu_ffn?" / CPU FFN "+r.cpu_ffn:"")+(r.card_format==="markdown"?" / Markdown":r.label.includes("recheck")?" / seed 7":"");
const gib=(m:number)=> (m/1024).toFixed(2);
const sec=(v:number|null|undefined)=>v==null?"—":v.toFixed(2);
export default function Comparison(){
 const theme=useHostTheme(), dispatch=useCanvasAction();
 const [tab,setTab]=useCanvasState("tab","results"), [selected,setSelected]=useCanvasState("run",RUNS[0].label);
 const run=RUNS.find(r=>r.label===selected)??RUNS[0];
 const complete=RUNS.filter(r=>r.status==="completed"&&!r.diagnostic);
 const resource=complete.filter(r=>!r.label.includes("recheck"));
 const open=(path:string)=>dispatch({type:"openFile",path});
 return <Stack gap={22} style={{padding:28,color:theme.text.primary,background:theme.bg.editor,maxWidth:1250,margin:"0 auto"}}>
  <Stack gap={8}><Text size="small" tone="secondary">本地实测 · 2026-10-20 · 中文陪伴 / 角色扮演</Text><H1>{DATA.assessment.headline}</H1><Text>{DATA.assessment.conclusion}</Text></Stack>
  <Callout tone="warning">测试机为 RTX 5060 Ti 16GB / 64GB RAM。下方是服务进程自身的专用显存与 RAM RSS 峰值；低于 6GiB 只证明资源预算可行，尚未在物理 6GB 显卡验证。</Callout>
  <Row gap={8}><Pill active={tab==="results"} onClick={()=>setTab("results")}>结果与建议</Pill><Pill active={tab==="dialogues"} onClick={()=>setTab("dialogues")}>逐轮原文</Pill><Pill active={tab==="method"} onClick={()=>setTab("method")}>复现与局限</Pill></Row>
  {tab==="results"&&<Stack gap={22}>
   <Grid columns="repeat(auto-fit,minmax(260px,1fr))" gap={24}>{DATA.assessment.models.map(m=><Stack gap={8} key={m.id}><H2>{NAMES[m.id]}</H2><Text weight="semibold">{m.verdict}</Text>{m.findings.map((s,i)=><Text key={i}>{s}</Text>)}</Stack>)}</Grid>
   <H2>16K / 32K 的进程资源峰值</H2>
   <Text size="small" tone="secondary">横轴：运行配置；纵轴：专用显存峰值（GiB）。来源：Windows GPU Process Memory PDH，每 0.25 秒采样，含加载与请求阶段。日期：2026-10-20。</Text>
   <BarChart categories={resource.map(name)} series={[{name:"进程专用显存峰值",data:resource.map(r=>+(r.peaks.gpu_dedicated_mib/1024).toFixed(2)),tone:"info"}]} height={300} showValues valueSuffix=" GiB" referenceLines={[{value:5.5,label:"预留桌面余量的参考预算 5.5GiB",tone:"warning"},{value:6,label:"6GiB",tone:"danger"}]}/>
   <Table headers={["配置","显存 GiB","RAM RSS GiB","私有提交 GiB","检索事实","长输入首字 s","生成 token/s"]} columnAlign={["left","right","right","right","center","right","right"]} rows={resource.map(r=>{const q=r.requests.find(q=>q.id==="long-recall");return [name(r),gib(r.peaks.gpu_dedicated_mib),gib(r.peaks.rss_mib),gib(r.peaks.private_commit_mib),q?.recall_pass!=null?q.recall_pass+"/9":"—",sec(q?.first_visible_s),q?.timings.predicted_per_second.toFixed(1)??"—"]})}/>
   <Text size="small" tone="secondary">检索输入 14,080 / 30,464 tokens，窗口 16,384 / 32,768，预留 2,304。RAM RSS 包括驻留的模型映射，不包括整个操作系统文件缓存；私有提交与 RSS 有重叠，不能相加。生成速度来自长检索请求，不能代表全部聊天速度。</Text>
   <H2>如何看待长上下文</H2><Text>{DATA.assessment.long_context}</Text><Text>{DATA.assessment.baseline}</Text>
   <H2>已观察到的限制</H2>{DATA.assessment.limitations.map((s,i)=><Text key={i}>{s}</Text>)}
  </Stack>}
  {tab==="dialogues"&&<Stack gap={16}>
   <Row gap={6} wrap>{complete.map(r=><Pill key={r.label} active={run.label===r.label} onClick={()=>setSelected(r.label)}>{name(r)}</Pill>)}</Row>
   <H2>{name(run)}</H2><Text size="small" tone="secondary">seed={run.seed} · card={run.card_format??"prose"} · {JSON.stringify(run.sampler)}。不同模型采用记录在案的采样设置，属于部署方案对比，并非只改变模型权重的实验。</Text>
   {run.requests.map(q=><Stack key={q.id} gap={8} style={{borderTop:"1px solid "+theme.stroke.tertiary,paddingTop:16}}>
    <Row justify="space-between" wrap><H3>{q.id}</H3><Text size="small" tone="secondary">首字 {sec(q.first_visible_s)}s · 总计 {q.wall_s.toFixed(2)}s · {q.tokens_predicted} tokens{q.stopped_limit?" · 达到输出上限":""}</Text></Row>
    {q.user&&<Text tone="secondary">用户：{q.user}</Text>}<Text style={{whiteSpace:"pre-wrap"}}>{q.visible||"本轮未生成正文"}</Text>
    {q.recall_checks&&<Text size="small" tone="secondary">{Object.entries(q.recall_checks).map(([k,v])=>k+"："+(v?"找回":"未找回")).join(" · ")}</Text>}
    <Button variant="ghost" onClick={()=>open(q.path)}>打开完整请求与资源记录</Button>
   </Stack>)}
  </Stack>}
  {tab==="method"&&<Stack gap={16}>
   <H2>测试方法</H2><Text>同一运行时 llama.cpp b11729 / Windows CUDA 13.4；只加载文本 GGUF，不加载视觉投影。KV 为 Q8，单槽、Flash Attention、batch 256 / ubatch 128，CPU 8 / batch 12 线程。所有请求 cache_prompt=false，测冷读；服务只监听 127.0.0.1，测试后结束自己启动的服务。</Text>
   <Text>每款首轮包括相同的陪伴 6 轮、客栈角色 6 轮，以及独立伴侣场景 3 轮；查看身份、指代、用户边界、约定更新和重复。MiniFantasy 按作者建议另测 Markdown 分类角色卡；Huihui 和硅基女友另用 seed 7 复核。长检索将 9 项明确事实分布在合成日常记录的早中晚位置；长接戏要求在另一份合成历史后自然回应。它们均不能替代真实 32K 多轮聊天。</Text>
   <Text>使用 GGUF 自带聊天模板，enable_thinking=false，不强行附加思考前缀。MiniFantasy 使用作者采样预设的有效参数；DRY penalty_last_n=0，按该预设关闭 DRY 窗口。硅基女友使用作者 temperature=.7 / top_p=.8 / top_k=20 / presence_penalty=1.5；Huihui 使用相同参数作基线。每次输出上限 1,024 tokens。</Text>
   <Text>当前只测试中文陪伴、非露骨浪漫互动和虚构剧情；没有验证 NSFW 内容表现。结果 status=completed 只表示请求完成，failures 仅记录运行错误，不能视为内容质量通过。人工观察逐项列出，没有以中文比例代替质量分数，也没有声称这是社区最强模型。</Text>
   <H2>固定版本与原始证据</H2>{DATA.manifest.models.map(m=><Stack gap={6} key={m.id}><H3>{NAMES[m.id]}</H3><Text>{m.repo}</Text><Text size="small" tone="secondary">revision {m.revision} · SHA256 {m.sha256}</Text></Stack>)}
   {RUNS.map(r=><Button key={r.label} variant="ghost" onClick={()=>open(r.path)}>{r.label} · {r.status}</Button>)}
  </Stack>}
 </Stack>;
}
'''
    destination.write_text(template.replace("__DATA__", json.dumps(data, ensure_ascii=False, separators=(",", ":"))), encoding="utf-8")
    print(json.dumps({"canvas": str(destination), "runs": len(runs)}))


if __name__ == "__main__":
    main()
