import test from "node:test";
import assert from "node:assert/strict";
import { tombstone } from "../src/adapter.js";
import { messageMeta } from "../src/shared.js";

test("recall wording is recognized for the supported Facebook languages", () => {
  for (const text of [
    "You unsent a message", "Minh removed a message.", "Bạn đã thu hồi một tin nhắn", "Minh đã xoá một tin nhắn.",
    "Anulaste el envío de un mensaje", "Ana anuló el envío de un mensaje", "Vous avez retiré un message", "Paul a retiré un message",
    "Du hast eine Nachricht zurückgezogen", "Anna hat eine Nachricht zurückgerufen", "Hai annullato l'invio di un messaggio", "Luca ha annullato l'invio di un messaggio",
    "Você cancelou o envio de uma mensagem", "Ana cancelou o envio de uma mensagem", "Anda membatalkan pengiriman pesan", "Budi membatalkan pengiriman pesan",
  ]) assert.equal(tombstone(text), true, text);
});
test("ordinary sentences around the same words are not treated as a recall", () => {
  for (const text of ["Xin chào", "I never unsent a message yesterday, sorry", "Mình đã xóa nhầm", "Eliminé el mensaje de ayer", "Il a retiré son message hier soir", "Saya menghapus pesan", "Ele removeu uma mensagem", "Anna hat eine Nachricht entfernt", "Sent", ""])
    assert.equal(tombstone(text), false, text);
});
test("message details are bounded and invalid values are dropped", () => {
  const clean = messageMeta({ senderId: "123", sentAt: 1800000000000, senderName: "x".repeat(500), replyText: "y".repeat(900), label: "z".repeat(400) });
  assert.equal(clean.senderId, "123"); assert.equal(clean.sentAt, 1800000000000);
  assert.equal(clean.senderName.length, 120); assert.equal(clean.replyText.length, 500); assert.equal(clean.label.length, 200);
  assert.deepEqual(messageMeta({ senderId: "<script>", sentAt: 12, senderName: "   ", replyText: 4, label: null }), { senderId: undefined, sentAt: undefined, senderName: undefined, replyText: undefined, label: undefined });
});
