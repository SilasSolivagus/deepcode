import { z } from 'zod'
import { emitNotification, notifSequence, resolveNotifChannel } from '../notify.js'
import { loadSettings } from '../config.js'
import type { Tool } from './types.js'

/** 兼容别名（既有 test/tools/pushNotification.test.ts 直接断言）：auto 渠道序列。 */
export const oscNotification = (m: string, term?: string): string => notifSequence(m, 'auto', term)!

const schema = z.object({
  message: z.string().describe('通知正文，<200 字，一行，无 markdown。开头放用户要处理的事'),
  status: z.literal('proactive'),
})

export const pushNotificationTool: Tool<typeof schema> = {
  name: 'PushNotification',
  description:
    '在用户终端发桌面通知，把注意力从别处拉到本会话——这是成本，故宁可不发。\n\n' +
    '别为常规进度/刚问完还在看的事/快速完成发。在用户可能已离开且有值得回来的事时发，或用户明确要求时发。<200 字一行。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input, ctx) {
    const channel = resolveNotifChannel(loadSettings(ctx.cwd()).preferredNotifChannel)
    const msg = input.message.slice(0, 200).replace(/\n/g, ' ')
    emitNotification(msg, channel)
    return `已发送桌面通知：${msg}`
  },
}
