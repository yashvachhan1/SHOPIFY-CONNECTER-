const sendResponse = (res, statusCode, message, data = {}, error = null) => {
  return res.status(statusCode).json({
    success: statusCode >= 200 && statusCode < 300,
    message,
    data,
    error
  });
};

module.exports = { sendResponse };
