// 使用者引導（導覽／說明抽屜／空狀態）的字串；由元件 import 時註冊，不改 i18n/*.json
import i18n from 'i18next'

export const guideZhTW = {
  guide: {
    tour: {
      skip: '跳過', prev: '上一步', next: '下一步', done: '完成', replay: '重看導覽', stepOf: '第 {{i}} 步，共 {{n}} 步', aria: '首次導覽',
      steps: {
        sidebar: { title: '側欄分四群', body: '「工作」是每天會用的：工作臺、收件匣、群聊、工作流、看板。「AI 員工」管人設與模型。「連接」接 LINE 與排程。「系統」看用量、護欄與日誌。' },
        workbench: { title: '工作臺：跟一位 AI 員工聊', body: '左上角先選員工，按「+ 新對話」就能開始。Ctrl/⌘+K 可以搜尋所有對話。' },
        agents: { title: 'AI 員工＝一個 Hermes profile', body: '每個 profile（~/.hermes/profiles/<名稱>）在這裡對應一位員工。開啟後填名稱與職稱，點 SOUL 改人設，存檔下一次對話就生效。' },
        workflows: { title: '工作流＝一條生產線', body: '幾個站接起來：找題材 → 等我確認 → 寫成文章。跑到「等我確認」會停下來等你點頭，通過了才花下一段錢。' },
        inbox: { title: '收件匣是你唯一要看的地方', body: '要人決定的事都會進來：工作流閘門、對話裡的危險指令、卡住的看板卡、群聊點名、用量超額。處理完就消失。' },
        limits: { title: '成本護欄', body: '花錢的只有送進 Hermes 的 tokens。這裡設公司或員工每日 token／美元上限，超過就自動停用或通知；「用量」頁看 30 日花了多少。' },
      },
    },
    help: { open: '這頁怎麼用', close: '關閉說明', what: '這頁做什麼', how: '怎麼用', faq: '常見問題', related: '相關頁面', replayTour: '重看首次導覽', fallbackTitle: '說明' },
    empty: {
      sessions: { title: '還沒有對話', body: '工作臺就是你跟一位 AI 員工的聊天室。選好員工後開一個新對話，輸入任務就會開始跑。', action: '＋ 建立新對話' },
      workflows: { title: '還沒有工作流', body: '一條生產線就是幾個站接起來：一站做完，把產出交給下一站，中間可以停下來等你確認。先選一個範本，選完直接能跑，再照自己的做法改。', action: '選一個範本開始', create: '＋ 自己新建' },
      rooms: { title: '還沒有群聊房間', body: '群聊讓兩位以上 AI 員工在同一間房討論，用 @名字 指定誰回。也可以用邀請碼加入同事的房間。', action: '＋ 建立房間' },
      cards: { title: '看板還是空的', body: '看板跟 `hermes kanban` 是同一份資料。建一張卡、指派給 AI 員工，按「派工」就交給 Hermes dispatcher 去跑。', action: '＋ 建立第一張卡' },
      events: { title: '這段時間沒有事件', body: '每一次對話、工作流、投遞、人類決策都會留一筆事件。把日期區間拉大，或先去工作臺跑一次對話。', action: '前往工作臺' },
      inbox: { title: '收件匣是空的，沒有事等你決定', body: '工作流跑到閘門、AI 想執行危險指令、看板卡片卡住時，才會出現在這裡。現在可以放心去做別的事。', action: '看看工作流' },
      channels: { title: '還沒接任何平台', body: '先接 LINE：在 LINE Developers 建 Messaging API channel，把 token／secret 填進下面的表單，存檔後重啟 gateway，再把 webhook URL 貼回 LINE。', action: '填 LINE 設定' },
      canvas: { title: '畫布是空的', body: '一鍵載入範例：熱點 → 選題 → 審批閘門 → 文案。載入後改各節點的 prompt，存檔再執行。', action: '載入範例流程', addHint: '或用上方「加節點」自己放' },
    },
    template: { hot: '熱點', topic: '選題', gate: '審批閘門', copy: '文案', name: '範例：熱點→選題→閘門→文案',
      hotPrompt: '找出本週 3 個與我們業務相關的熱點，每個附一句證據與來源。', topicPrompt: '從上游熱點挑一個最值得寫的題目，給標題與三個論點。', copyPrompt: '依審批通過的選題寫 600 字貼文，口語、短句、結尾給一個行動。' },
  },
}

export const guideEn = {
  guide: {
    tour: {
      skip: 'Skip', prev: 'Back', next: 'Next', done: 'Done', replay: 'Replay tour', stepOf: 'Step {{i}} of {{n}}', aria: 'Onboarding tour',
      steps: {
        sidebar: { title: 'Four sidebar groups', body: 'Work: workbench, inbox, group chat, workflows, kanban. Agents: personas and models. Connect: LINE and cron. System: usage, limits, logs.' },
        workbench: { title: 'Workbench: chat with one agent', body: 'Pick an agent top-left, press “+ New session”. Ctrl/⌘+K searches every session.' },
        agents: { title: 'An agent is a Hermes profile', body: 'Each profile under ~/.hermes/profiles maps to one agent. Enable it, name it, edit SOUL; saved SOUL applies on the next run.' },
        workflows: { title: 'A workflow is a pipeline', body: 'A few steps in a row: find topics → wait for me → write the post. It stops for your approval before spending more.' },
        inbox: { title: 'Inbox is the only place to watch', body: 'Everything needing a human lands here: gates, dangerous commands, stuck cards, mentions, over-budget. Handled items disappear.' },
        limits: { title: 'Cost guardrails', body: 'Only tokens sent to Hermes cost money. Set daily token/USD limits per company or agent; “Usage” shows 30-day spend.' },
      },
    },
    help: { open: 'How to use this page', close: 'Close help', what: 'What this page does', how: 'How to use', faq: 'FAQ', related: 'Related pages', replayTour: 'Replay onboarding tour', fallbackTitle: 'Help' },
    empty: {
      sessions: { title: 'No sessions yet', body: 'The workbench is a chat with one agent. Pick an agent, open a new session, type a task.', action: '+ New session' },
      workflows: { title: 'No workflows yet', body: 'A pipeline is a few steps in a row: each hands its output to the next, and it can stop for you in between. Start from a template - it runs as-is - then make it yours.', action: 'Start from a template', create: '+ Create your own' },
      rooms: { title: 'No rooms yet', body: 'Group chat puts two or more agents in one room; @name picks who answers. Join a colleague’s room with an invite code.', action: '+ Create room' },
      cards: { title: 'Board is empty', body: 'Same data as `hermes kanban`. Create a card, assign an agent, press Dispatch.', action: '+ Create first card' },
      events: { title: 'No events in this range', body: 'Every session, workflow, delivery and decision leaves an event. Widen the date range or run a chat first.', action: 'Go to workbench' },
      inbox: { title: 'Inbox is empty', body: 'Items appear when a workflow hits a gate, an agent wants a dangerous command, or a card gets stuck.', action: 'See workflows' },
      channels: { title: 'No platform connected', body: 'Start with LINE: create a Messaging API channel, fill token/secret below, save, restart gateway, paste the webhook URL back.', action: 'Fill LINE settings' },
      canvas: { title: 'Canvas is empty', body: 'Load the example: hot → pick → gate → copy. Edit prompts, save, run.', action: 'Load example', addHint: 'or add nodes from the toolbar' },
    },
    template: { hot: 'Hot topics', topic: 'Pick topic', gate: 'Approval gate', copy: 'Copy', name: 'Example: hot → pick → gate → copy',
      hotPrompt: 'Find 3 hot topics this week related to our business, each with one line of evidence and a source.', topicPrompt: 'Pick the single best topic from upstream; give a title and three arguments.', copyPrompt: 'Write a 600-word post based on the approved topic; short sentences, end with one call to action.' },
  },
}

if (!i18n.exists('guide.tour.skip')) {
  i18n.addResourceBundle('zh-TW', 'translation', guideZhTW, true, true)
  i18n.addResourceBundle('en', 'translation', guideEn, true, true)
}
