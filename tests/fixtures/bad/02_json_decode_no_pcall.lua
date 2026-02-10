-- BAD: json.decode without pcall wrapper
-- Expected: JSON_DECODE_NO_PCALL (high) at line 9

State = State or { Owner = "owner-address", Params = {} }

Handlers.add("Update", { Action = "Update" }, function(msg)
  if msg.From == State.Owner then
    -- NO pcall - malformed JSON will crash the handler!
    local params = require("json").decode(msg.Data)
    State.Params = params
  end
end)
