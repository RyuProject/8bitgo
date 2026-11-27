/** 邮件模板的 HTML 转义回归，不需要网络或数据库。 */
import assert from 'node:assert/strict'
import { escapeHtml } from '../src/html.js'

const value = 'https://safe.example/" onmouseover="alert(1)'
const escaped = escapeHtml(value)
assert.equal(escaped, 'https://safe.example/&quot; onmouseover=&quot;alert(1)')
const emailHtml = `<a href="${escaped}" rel="noreferrer noopener">${escaped}</a>`
assert.doesNotMatch(emailHtml, /href="[^"]*"\s+onmouseover=/i)
assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;')
console.log('✅ 邮件文本和 href 属性中的用户内容均转义')
