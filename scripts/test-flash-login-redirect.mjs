/** SAS3 主 SWF 绕过 Banana 的 navigateToURL 必须仍然打开 8BitGo 登录框。 */
import assert from 'node:assert/strict'
import { installFlashLegacyLoginRedirect } from '../src/emulator/flashLegacyLogin.ts'

const opened = []
let loginCount = 0
const originalOpen = function(url, target, features) {
  opened.push([String(url), target, features])
  return { opened: true }
}
const submitted = []
function FakeForm(action) {
  this.action = action
}
const originalSubmit = function() {
  submitted.push(this.action)
}
FakeForm.prototype.submit = originalSubmit
const listeners = new Map()
const win = {
  location: { href: 'https://8bitgo.com/flash-frames/sas-zombie-assault-3/frame.html' },
  open: originalOpen,
  HTMLFormElement: FakeForm,
  document: {
    addEventListener(type, callback) { listeners.set(type, callback) },
    removeEventListener(type, callback) {
      if (listeners.get(type) === callback) listeners.delete(type)
    },
  },
}

const cleanup = installFlashLegacyLoginRedirect(
  win,
  ['https://ninjakiwi.com/login', 'http://ninjakiwi.com/login'],
  () => { loginCount++ },
)

assert.equal(win.open('https://ninjakiwi.com/login?from=SAS3', '_blank'), null)
assert.equal(loginCount, 1, '旧 Ninja Kiwi 登录按钮应接回站内登录框')
assert.equal(opened.length, 0, '旧登录页不应再打开新标签')

assert.deepEqual(win.open('https://example.com/help', '_blank'), { opened: true })
assert.deepEqual(opened, [['https://example.com/help', '_blank', undefined]], '其它游戏外链必须保持原样')

const loginForm = new FakeForm('https://ninjakiwi.com/login?from=SAS3')
loginForm.submit()
assert.equal(loginCount, 2, 'Ruffle 的 form.submit 登录路径也应接回站内登录框')
assert.deepEqual(submitted, [], '旧登录表单不应真的提交到 Ninja Kiwi')

const helpForm = new FakeForm('https://example.com/help')
helpForm.submit()
assert.deepEqual(submitted, ['https://example.com/help'], '其它表单跳转必须保持原样')

let prevented = false
listeners.get('submit')({
  target: loginForm,
  preventDefault() { prevented = true },
})
assert.equal(prevented, true, 'requestSubmit 路径应在提交前被阻止')
assert.equal(loginCount, 3)

cleanup()
assert.equal(win.open, originalOpen, '销毁游戏时必须恢复 iframe 的 open')
assert.equal(FakeForm.prototype.submit, originalSubmit, '销毁游戏时必须恢复 iframe 的 form.submit')
assert.equal(listeners.has('submit'), false, '销毁游戏时必须移除 submit 监听器')
console.log('Flash 旧登录跳转自测通过：window.open / form.submit 精确拦截、其它外链放行、销毁恢复')
