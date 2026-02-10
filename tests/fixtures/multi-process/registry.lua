-- Registry Process
-- Tracks all registered processes and their versions

State = {
  Processes = {},
  Admin = nil
}

-- Register a new process
Handlers.add("Register", Handlers.utils.hasMatchingTag("Action", "Register"), function(msg)
  local data = json.decode(msg.Data)
  State.Processes[msg.From] = {
    type = data.type,
    processId = data.processId,
    registeredAt = msg.Timestamp
  }

  ao.send({
    Target = msg.From,
    Action = "Registered",
    Data = json.encode({ success = true })
  })
end)

-- Handle state change notifications
Handlers.add("StateChanged", Handlers.utils.hasMatchingTag("Action", "StateChanged"), function(msg)
  local data = json.decode(msg.Data)
  if State.Processes[data.process] then
    State.Processes[data.process].version = data.version
    State.Processes[data.process].updatedAt = msg.Timestamp
  end
end)

-- List all registered processes
Handlers.add("List", Handlers.utils.hasMatchingTag("Action", "List"), function(msg)
  ao.send({
    Target = msg.From,
    Action = "ProcessList",
    Data = json.encode(State.Processes)
  })
end)

-- Admin: Deregister a process
Handlers.add("Deregister", function(msg)
  return msg.Tags.Action == "Deregister" and msg.From == State.Admin
end, function(msg)
  local processId = msg.Tags.ProcessId
  State.Processes[processId] = nil

  ao.send({
    Target = msg.From,
    Action = "Deregistered",
    Data = json.encode({ processId = processId })
  })
end)
