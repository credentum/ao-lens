-- BAD: msg.Action doesn't exist in AO - should be msg.Tags.Action
-- Expected: MSG_ACTION_DIRECT_ACCESS finding

State = State or { Owner = "owner-address", Data = {} }

Handlers.add("Update", function(msg)
  if msg.Action ~= "Update" then return false end
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return false end
  return true
end, function(msg)
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)
