import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import LudoGame from './LudoGame'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LudoGame serverUrl="http://localhost:3001" />
  </React.StrictMode>
)
