import test from 'node:test'
import assert from 'node:assert/strict'
import { DjDeck } from '../flow/dj.js'
function fixture() {
  const param = () => ({value:0,setValueAtTime(v){this.value=v}})
  const node = () => ({frequency:param(),Q:param(),gain:param(),playbackRate:param(),connect(n){return n},disconnect(){},start(){},stop(){}})
  const ctx = {currentTime:0,createBiquadFilter:node,createGain:node,createBufferSource:node}
  const deck = new DjDeck(ctx,node());deck.setTrack({duration:60},120)
  return {ctx,deck}
}
test('DJ tempo changes preserve position; pause and cue resume on the audio clock',()=>{
  const {ctx,deck}=fixture();deck.play();ctx.currentTime=5;deck.tempo(1.1)
  assert.equal(deck.position(),5);ctx.currentTime=15;assert.equal(deck.position(),16)
  deck.pause();ctx.currentTime=30;assert.equal(deck.position(),16)
  deck.seek(3);deck.play();ctx.currentTime=40;assert.equal(deck.position(),14)
})
test('Releasing a loop continues at its audible position without jumping forward',()=>{
  const {ctx,deck}=fixture();deck.play();ctx.currentTime=4;deck.setLoop(4)
  ctx.currentTime=13;assert.equal(deck.position(),5)
  deck.setLoop(4);assert.equal(deck.position(),5)
  ctx.currentTime=14;assert.equal(deck.position(),6)
})
