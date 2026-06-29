/**
 * Advanced Statistical Forecast Engine (Pure Math)
 * 
 * Includes Outlier Detection, Seasonality, SMA, EMA, Linear Regression,
 * Holt Linear Trend, Confidence Intervals, and Automatic Model Selection.
 */

export type ForecastPeriod = 7 | 30 | 90

export interface DataPoint {
  date: string
  value: number
}

export interface ForecastResult {
  metric: string
  predicted_value: number
  confidence: number
  trend: 'up' | 'down' | 'flat'
  model_used: string
  lower_bound?: number
  upper_bound?: number
  mse?: number
}

/**
 * Z-Score Outlier Detection & Removal
 */
export function removeOutliers(data: DataPoint[], threshold: number = 2.5): DataPoint[] {
  if (data.length < 5) return data
  const mean = data.reduce((sum, d) => sum + d.value, 0) / data.length
  const stdDev = Math.sqrt(data.reduce((sum, d) => sum + Math.pow(d.value - mean, 2), 0) / data.length)
  
  if (stdDev === 0) return data
  
  return data.filter(d => Math.abs((d.value - mean) / stdDev) <= threshold)
}

/**
 * Basic Seasonality Smoothing (7-day periodic average)
 */
export function deseasonalize(data: DataPoint[]): DataPoint[] {
  if (data.length < 14) return data
  const smoothed = [...data]
  for (let i = 7; i < data.length - 7; i++) {
    const weeklyAvg = (data[i-7].value + data[i].value + data[i+7].value) / 3
    smoothed[i] = { ...data[i], value: (data[i].value + weeklyAvg) / 2 }
  }
  return smoothed
}

/**
 * Auto Model Selection by lowest MSE on historical backtest
 */
export function generateForecast(data: DataPoint[], period: ForecastPeriod): ForecastResult {
  const cleanedData = deseasonalize(removeOutliers(data))
  
  if (cleanedData.length < 3) {
    return runFallback(cleanedData, period)
  }

  // Backtest models by hiding last 20% of data
  const splitIndex = Math.floor(cleanedData.length * 0.8)
  const trainData = cleanedData.slice(0, splitIndex)
  const testData = cleanedData.slice(splitIndex)
  const testPeriod = testData.length

  const models = [
    { name: 'Linear', fn: forecastLinearRegression },
    { name: 'Holt', fn: forecastHoltLinear },
    { name: 'EMA', fn: forecastEMA }
  ]

  let bestModel = models[0]
  let lowestMse = Infinity

  for (const model of models) {
    const prediction = model.fn(trainData, testPeriod as any)
    const avgPredictedPerDay = prediction.predicted_value / testPeriod
    
    // Calculate MSE against test set
    let mse = 0
    testData.forEach(d => {
      mse += Math.pow(d.value - avgPredictedPerDay, 2)
    })
    mse = mse / testPeriod

    if (mse < lowestMse) {
      lowestMse = mse
      bestModel = model
    }
  }

  // Generate final forecast with all data using best model
  const finalResult = bestModel.fn(cleanedData, period)
  finalResult.model_used = bestModel.name
  finalResult.mse = lowestMse

  return finalResult
}

// -----------------------------------------------------
// Individual Models
// -----------------------------------------------------

function runFallback(data: DataPoint[], period: ForecastPeriod): ForecastResult {
  const avg = data.length > 0 ? (data.reduce((s,d) => s + d.value, 0) / data.length) * period : 0
  return {
    metric: 'fallback',
    predicted_value: avg,
    confidence: 10,
    trend: 'flat',
    model_used: 'SMA Fallback',
    lower_bound: avg * 0.8,
    upper_bound: avg * 1.2,
    mse: 0
  }
}

export function forecastEMA(data: DataPoint[], period: ForecastPeriod): ForecastResult {
  const smoothing = 2
  const k = smoothing / (data.length + 1)
  let ema = data[0].value
  for (let i = 1; i < data.length; i++) {
    ema = (data[i].value * k) + (ema * (1 - k))
  }
  const predicted = ema * period
  return {
    metric: 'ema',
    predicted_value: predicted,
    confidence: 50,
    trend: ema > data[0].value ? 'up' : 'down',
    model_used: 'EMA',
    lower_bound: predicted * 0.8,
    upper_bound: predicted * 1.2
  }
}

export function forecastHoltLinear(data: DataPoint[], period: ForecastPeriod): ForecastResult {
  const alpha = 0.3, beta = 0.1
  let level = data[0].value
  let trend = data[1].value - data[0].value

  for (let i = 1; i < data.length; i++) {
    const val = data[i].value
    const lastLevel = level
    level = alpha * val + (1 - alpha) * (lastLevel + trend)
    trend = beta * (level - lastLevel) + (1 - beta) * trend
  }

  let predictedTotal = 0
  for (let i = 1; i <= period; i++) {
    predictedTotal += Math.max(0, level + (i * trend))
  }

  return {
    metric: 'holt',
    predicted_value: predictedTotal,
    confidence: 60,
    trend: trend > 0 ? 'up' : 'down',
    model_used: 'Holt',
    lower_bound: predictedTotal * 0.8,
    upper_bound: predictedTotal * 1.2
  }
}

export function forecastLinearRegression(data: DataPoint[], period: ForecastPeriod): ForecastResult {
  const n = data.length
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0

  data.forEach((point, i) => {
    sumX += i
    sumY += point.value
    sumXY += i * point.value
    sumXX += i * i
  })

  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX)
  const intercept = (sumY - slope * sumX) / n

  let sumSqErr = 0
  data.forEach((point, i) => {
    sumSqErr += Math.pow(point.value - (slope * i + intercept), 2)
  })
  const stdError = Math.sqrt(sumSqErr / (n - 2))
  const marginError = 1.96 * stdError * Math.sqrt(period)

  let predictedTotal = 0
  for (let i = n; i < n + period; i++) {
    predictedTotal += Math.max(0, slope * i + intercept)
  }

  let trend: 'up' | 'down' | 'flat' = 'flat'
  if (slope > (sumY/n)*0.03) trend = 'up'
  else if (slope < -(sumY/n)*0.03) trend = 'down'

  return {
    metric: 'linear',
    predicted_value: predictedTotal,
    confidence: Math.min(95, Math.max(30, (n / period) * 100)),
    trend,
    model_used: 'Linear Regression',
    lower_bound: Math.max(0, predictedTotal - marginError),
    upper_bound: predictedTotal + marginError
  }
}
