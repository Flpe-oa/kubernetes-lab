const express = require('express')
const os = require('os')
const app = express()

app.use(express.json())

app.get('/', (req, res) => {
  res.json({
    message: 'API funcionando!',
    pod: os.hostname(),
    timestamp: new Date()
  })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

app.get('/users', (req, res) => {
  res.json({
    users: [
      { id: 1, name: 'Felipe', role: 'admin' },
      { id: 2, name: 'João',   role: 'dev'   },
    ],
    served_by: os.hostname()
  })
})

app.listen(3000, () => console.log('API rodando na porta 3000'))
