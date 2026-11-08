import {createHmac,randomBytes} from 'node:crypto'
// Only encrypted storageState bytes leave the connector. The PHP host stores no VK plaintext.
export class RemoteState {
  constructor(url, secret) { const u=new URL(url); if(u.protocol!=='https:' && !['127.0.0.1','localhost'].includes(u.hostname))throw Error('State storage requires HTTPS');this.url=u.href;this.secret=secret }
  async request(uid,op,bytes,attempt=0){
    if(!/^\d{1,20}$/.test(String(uid)))throw Error('Invalid state user')
    const body=JSON.stringify({uid:String(uid),op,...(bytes?{data:bytes.toString('base64')}:{})})
    const time=String(Date.now()),nonce=randomBytes(16).toString('hex')
    const signature=createHmac('sha256',this.secret).update(`flow-state-v1\n${time}\n${nonce}\n${body}`).digest('hex')
    let r
    try { r=await fetch(this.url,{method:'POST',body,redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-Flow-Time':time,'X-Flow-Nonce':nonce,'X-Flow-Signature':signature}}) }
    catch(error) {
      if (attempt < 2 && ['UND_ERR_SOCKET','ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(error.cause?.code || error.code)) {
        return this.request(uid,op,bytes,attempt+1)
      }
      throw error
    }
    if(!r.ok)throw Error('Не удалось открыть защищённое хранилище сессии VK. Повторный вход не требуется.')
    const data=await r.json();return data.data?Buffer.from(data.data,'base64'):undefined
  }
  read(uid){return this.request(uid,'read')}
  write(uid,bytes){return this.request(uid,'write',bytes)}
  remove(uid){return this.request(uid,'delete')}
}
