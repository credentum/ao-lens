-- GOOD: Uses msg.Tags.Action with nil guard (correct AO pattern)
-- Expected: NO findings

State = State or { Owner = "owner-address", Data = {} }

Handlers.add("Update", function(msg)
  -- Proper nil guard for msg.Tags before accessing Action
  if not msg.Tags or msg.Tags.Action ~= "Update" then return false end
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return false end
  return true
end, function(msg)
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)
