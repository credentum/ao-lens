-- BAD: Handler mutates state without msg.From authorization
-- Expected: NO_AUTH_CHECK (critical) at line 8

State = State or { Owner = "owner-address", Data = {} }

Handlers.add("Update", { Action = "Update" }, function(msg)
  -- NO authorization check - anyone can mutate state!
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)
