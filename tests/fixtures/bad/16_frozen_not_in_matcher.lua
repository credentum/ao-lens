-- BAD: Frozen check in body but not in matcher - early rejection saves compute
-- Expected: FROZEN_CHECK_NOT_IN_MATCHER finding

State = State or { Owner = "owner-address", Data = {}, Frozen = false }

Handlers.add("Update", function(msg)
  -- Matcher doesn't check frozen
  if msg.Tags.Action ~= "Update" then return false end
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return false end
  return true
end, function(msg)
  -- Body checks frozen - but this wastes compute
  assert(not State.Frozen, "Process is frozen")
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)
