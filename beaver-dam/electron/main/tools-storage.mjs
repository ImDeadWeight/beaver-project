'use strict'

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

function getPath() {
  return path.join(app.getPath('userData'), 'tools.json')
}

function read() {
  const p = getPath()
  if (!fs.existsSync(p)) return { tools: [], groups: [] }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return { tools: [], groups: [] } }
}

function write(data) {
  fs.writeFileSync(getPath(), JSON.stringify(data, null, 2), 'utf8')
}

export function getUserTools() { return read().tools }
export function getUserGroups() { return read().groups }

export function addUserTool(tool) {
  const data = read()
  data.tools = data.tools.filter(t => t.id !== tool.id)
  data.tools.push({ ...tool, builtIn: false })
  write(data)
  return true
}

export function deleteUserTool(id) {
  const data = read()
  data.tools = data.tools.filter(t => t.id !== id)
  write(data)
  return true
}

export function addUserGroup(group) {
  const data = read()
  data.groups = data.groups.filter(g => g.id !== group.id)
  data.groups.push({ ...group, builtIn: false })
  write(data)
  return true
}

export function deleteUserGroup(id) {
  const data = read()
  data.groups = data.groups.filter(g => g.id !== id)
  write(data)
  return true
}
