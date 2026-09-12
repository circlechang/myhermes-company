// 使用者引導（導覽／說明抽屜／空狀態）的字串；由元件 import 時註冊，不改 i18n/*.json
import i18n from 'i18next'

export const guideZhTW = {
  guide: {
    tour: {
      skip: '跳過', prev: '上一步', next: '下一步', done: '完成', replay: '重看導覽', stepOf: '第 {{i}} 步，共 {{n}} 步', aria: '首次導覽',
      steps: {
        sidebar: { title: '側欄分五群', body: '「今天」先看要你決定的事。「對話」跟員工聊、寫文件、開群聊。「工作」是收件匣、流程、看板、文件。「員工」管人設、Skills 與模型。「設定」把連接、成本、外觀、系統都收在一頁。' },
        today: { title: '今天：老闆只看三件事', body: '等你決定的、出問題的、今天花了多少。處理完就消失；一切正常時這頁會很空。' },
        workbench: { title: '工作臺：跟一位 AI 員工聊', body: '左上角先選員工，按「+ 新對話」就能開始。Ctrl/⌘+K 可以搜尋所有對話。' },
        agents: { title: 'AI 員工＝一個 Hermes profile', body: '每個 profile（~/.hermes/profiles/<名稱>）在這裡對應一位員工。開啟後填名稱與職稱，點 SOUL 改人設，存檔下一次對話就生效。' },
        workflows: { title: '流程＝一條生產線', body: '幾步接起來：找題材 → 等我看 → 寫成文章。跑到「等我看」會停下來等你點頭，通過了才花下一段錢。' },
        inbox: { title: '收件匣是你唯一要看的地方', body: '要人決定的事都會進來：流程等你看、對話裡的危險指令、卡住的看板卡、群聊點名、用量超額。處理完就消失。' },
        settings: { title: '設定：其他都收在這', body: '接 LINE、排程、檔案、用量、成本護欄、外觀、語音、日誌都從這一頁進去。要看 Session ID 這類系統資訊，打開「工程師模式」。' },
      },
    },
    help: { open: '這頁怎麼用', close: '關閉說明', what: '這頁做什麼', how: '怎麼用', faq: '常見問題', related: '相關頁面', replayTour: '重看首次導覽', fallbackTitle: '說明' },
    empty: {
      sessions: { title: '還沒有對話', body: '工作臺就是你跟一位 AI 員工的聊天室。選好員工後開一個新對話，輸入任務就會開始跑。', action: '＋ 建立新對話' },
      workflows: { title: '還沒有流程', body: '一條流程就是幾步接起來：一步做完，把產出交給下一步，中間可以停下來等你看。先選一個範本，選完直接能跑，再照自己的做法改。', action: '選一個範本開始', create: '＋ 自己新建' },
      rooms: { title: '還沒有房間', body: '開一個房間，把兩位以上員工拉進來一起討論。', action: '＋ 開一個房間' },
      cards: { title: '看板還是空的', body: '建一張卡、指派給員工，按「派工」就會開始做。', action: '＋ 建立第一張卡' },
      events: { title: '這段時間沒有事件', body: '每一次對話、流程、投遞、人類決策都會留一筆事件。把日期區間拉大，或先去工作臺跑一次對話。', action: '前往工作臺' },
      inbox: { title: '收件匣是空的，沒有事等你決定', body: '流程跑到閘門、AI 想執行危險指令、看板卡片卡住時，才會出現在這裡。現在可以放心去做別的事。', action: '看看流程' },
      channels: { title: '還沒接任何平台', body: '先接 LINE：建一個 LINE 官方帳號，把 token 貼進下面的表單，存檔後把這頁顯示的網址貼回 LINE 後台。', action: '填 LINE 設定' },
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
        sidebar: { title: 'Five sidebar groups', body: 'Today: what needs you. Chat: talk to staff, write docs, group rooms. Work: inbox, workflows, kanban, documents. Staff: personas, skills, models. Settings: connections, cost, appearance and system in one page.' },
        today: { title: 'Today: three questions', body: 'What needs my decision, what went wrong, what did it cost. Handled items disappear; a quiet day shows an empty page.' },
        workbench: { title: 'Workbench: chat with one agent', body: 'Pick an agent top-left, press “+ New session”. Ctrl/⌘+K searches every session.' },
        agents: { title: 'An agent is a Hermes profile', body: 'Each profile under ~/.hermes/profiles maps to one agent. Enable it, name it, edit SOUL; saved SOUL applies on the next run.' },
        workflows: { title: 'A workflow is a pipeline', body: 'A few steps in a row: find topics → wait for me → write the post. It stops for your approval before spending more.' },
        inbox: { title: 'Inbox is the only place to watch', body: 'Everything needing a human lands here: gates, dangerous commands, stuck cards, mentions, over-budget. Handled items disappear.' },
        settings: { title: 'Settings: everything else', body: 'LINE, cron, files, usage, limits, theme, voice and logs all start here. Turn on Engineer mode to see Session IDs and other system details.' },
      },
    },
    help: { open: 'How to use this page', close: 'Close help', what: 'What this page does', how: 'How to use', faq: 'FAQ', related: 'Related pages', replayTour: 'Replay onboarding tour', fallbackTitle: 'Help' },
    empty: {
      sessions: { title: 'No sessions yet', body: 'The workbench is a chat with one agent. Pick an agent, open a new session, type a task.', action: '+ New session' },
      workflows: { title: 'No workflows yet', body: 'A pipeline is a few steps in a row: each hands its output to the next, and it can stop for you in between. Start from a template - it runs as-is - then make it yours.', action: 'Start from a template', create: '+ Create your own' },
      rooms: { title: 'No rooms yet', body: 'Open a room and pull in two or more staff members to discuss together.', action: '+ Open a room' },
      cards: { title: 'Board is empty', body: 'Create a card, assign a staff member, press Dispatch and it gets going.', action: '+ Create first card' },
      events: { title: 'No events in this range', body: 'Every session, workflow, delivery and decision leaves an event. Widen the date range or run a chat first.', action: 'Go to workbench' },
      inbox: { title: 'Inbox is empty', body: 'Items appear when a workflow hits a gate, an agent wants a dangerous command, or a card gets stuck.', action: 'See workflows' },
      channels: { title: 'No platform connected', body: 'Start with LINE: create an Official Account, paste the token below, save, then paste the URL shown here into the LINE console.', action: 'Fill LINE settings' },
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
