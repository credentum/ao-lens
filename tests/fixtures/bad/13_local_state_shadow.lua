-- BAD: local State = shadows global state
-- Expected: LOCAL_STATE_SHADOW finding

local State = State or { Owner = "owner-address", Data = {} }

Handlers.add("Update", { Action = "Update" }, function(msg)
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return end
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)
