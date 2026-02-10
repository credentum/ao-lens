-- GOOD: Frozen check in BOTH matcher AND body (belt-and-suspenders)
-- NotExpected: FROZEN_CHECK_NOT_IN_MATCHER

State = State or { Owner = "owner-address", Data = {}, Frozen = false }

Handlers.add("Update", function(msg)
  -- Matcher rejects frozen early (saves compute)
  -- Proper nil guard for msg.Tags
  if not msg.Tags or msg.Tags.Action ~= "Update" then return false end
  if State.Frozen then return false end
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return false end
  return true
end, function(msg)
  -- Body also checks frozen (defense-in-depth)
  assert(not State.Frozen, "Process is frozen")
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)
