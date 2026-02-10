-- GOOD: Uses assertion-based auth (fails closed)
-- Expected: NO AUTH_CONDITIONAL_NOT_ASSERT finding

State = State or { Owner = "owner-address", Data = {} }

Handlers.add("Update", function(msg)
  if not msg.Tags or msg.Tags.Action ~= "Update" then return false end
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return false end
  return true
end, function(msg)
  -- Uses assert - fails closed, halts execution on violation
  assert(State.Owner ~= nil, "Owner not initialized")
  assert(msg.From ~= nil, "msg.From is nil")
  assert(msg.From == State.Owner, "Unauthorized")
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)
