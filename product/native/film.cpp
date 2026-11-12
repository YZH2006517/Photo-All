// SPDX-License-Identifier: GPL-3.0-or-later
// Photo All's compute backend. All Vulkan objects belong to a single worker.
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <vulkan/vulkan.h>

#define API extern "C" __declspec(dllexport)
namespace {
thread_local std::string lastError;
void check(VkResult status, const char *operation) {
  if (status != VK_SUCCESS)
    throw std::runtime_error(std::string(operation) + " (" +
                             std::to_string(status) + ")");
}
struct Buffer {
  VkBuffer handle = VK_NULL_HANDLE;
  VkDeviceMemory memory = VK_NULL_HANDLE;
  void *mapped = nullptr;
  VkDeviceSize capacity = 0;
};
struct Context {
  VkInstance instance = VK_NULL_HANDLE;
  VkPhysicalDevice physical = VK_NULL_HANDLE;
  VkDevice device = VK_NULL_HANDLE;
  VkQueue queue = VK_NULL_HANDLE;
  uint32_t family = 0;
  VkPhysicalDeviceProperties properties{};
  VkPhysicalDeviceMemoryProperties memoryProperties{};
  VkDescriptorSetLayout descriptorLayout = VK_NULL_HANDLE;
  VkDescriptorPool descriptorPool = VK_NULL_HANDLE;
  VkDescriptorSet descriptor = VK_NULL_HANDLE;
  VkPipelineLayout pipelineLayout = VK_NULL_HANDLE;
  VkPipeline pipeline = VK_NULL_HANDLE;
  VkPipeline spatialPipeline = VK_NULL_HANDLE;
  bool float64 = false;
  std::filesystem::path spatialPath;
  VkCommandPool commandPool = VK_NULL_HANDLE;
  VkCommandBuffer command = VK_NULL_HANDLE;
  VkFence fence = VK_NULL_HANDLE;
  std::array<Buffer, 3> buffers{};
  std::array<Buffer, 2> staging{};
  std::vector<std::pair<uint64_t, Buffer>> tables;
  std::array<double, 4> timings{};

  void releaseBuffer(Buffer &buffer) {
    if (buffer.mapped)
      vkUnmapMemory(device, buffer.memory);
    if (buffer.handle)
      vkDestroyBuffer(device, buffer.handle, nullptr);
    if (buffer.memory)
      vkFreeMemory(device, buffer.memory, nullptr);
    buffer = {};
  }
  ~Context() {
    if (device) {
      vkDeviceWaitIdle(device);
      for (auto &buffer : buffers)
        releaseBuffer(buffer);
      for (auto &buffer : staging)
        releaseBuffer(buffer);
      for (auto &entry : tables)
        releaseBuffer(entry.second);
      if (fence)
        vkDestroyFence(device, fence, nullptr);
      if (commandPool)
        vkDestroyCommandPool(device, commandPool, nullptr);
      if (spatialPipeline)
        vkDestroyPipeline(device, spatialPipeline, nullptr);
      if (pipeline)
        vkDestroyPipeline(device, pipeline, nullptr);
      if (pipelineLayout)
        vkDestroyPipelineLayout(device, pipelineLayout, nullptr);
      if (descriptorPool)
        vkDestroyDescriptorPool(device, descriptorPool, nullptr);
      if (descriptorLayout)
        vkDestroyDescriptorSetLayout(device, descriptorLayout, nullptr);
      vkDestroyDevice(device, nullptr);
    }
    if (instance)
      vkDestroyInstance(instance, nullptr);
  }
  void reserve(Buffer &buffer, VkDeviceSize bytes, bool preferLocal = false,
               bool deviceOnly = false, bool hostRead = false) {
    if (bytes <= buffer.capacity)
      return;
    if (bytes > properties.limits.maxStorageBufferRange)
      throw std::runtime_error("GPU storage buffer limit");
    releaseBuffer(buffer);
    VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
    info.size = bytes;
    info.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT |
                 VK_BUFFER_USAGE_TRANSFER_SRC_BIT |
                 VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    check(vkCreateBuffer(device, &info, nullptr, &buffer.handle),
          "create buffer");
    VkMemoryRequirements requirements;
    vkGetBufferMemoryRequirements(device, buffer.handle, &requirements);
    uint32_t type = UINT32_MAX;
    int best = -1;
    for (uint32_t i = 0; i < memoryProperties.memoryTypeCount; i++) {
      auto flags = memoryProperties.memoryTypes[i].propertyFlags;
      auto required = deviceOnly ? VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT
                                 : (VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
                                    VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
      if ((requirements.memoryTypeBits & (1u << i)) &&
          (flags & required) == required) {
        bool candidateLocal =
            (flags & VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT) != 0;
        int score =
            (candidateLocal == preferLocal ? 2 : 0) +
            (hostRead && (flags & VK_MEMORY_PROPERTY_HOST_CACHED_BIT) ? 4 : 0);
        if (score > best) {
          type = i;
          best = score;
        }
      }
    }
    if (type == UINT32_MAX)
      throw std::runtime_error("GPU has no coherent host-visible memory");
    VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
    allocation.allocationSize = requirements.size;
    allocation.memoryTypeIndex = type;
    check(vkAllocateMemory(device, &allocation, nullptr, &buffer.memory),
          "allocate buffer");
    check(vkBindBufferMemory(device, buffer.handle, buffer.memory, 0),
          "bind buffer");
    if (!deviceOnly)
      check(vkMapMemory(device, buffer.memory, 0, VK_WHOLE_SIZE, 0,
                        &buffer.mapped),
            "map buffer");
    buffer.capacity = bytes;
  }
  VkPipeline loadPipeline(const std::filesystem::path &path) {
    VkPipeline result = VK_NULL_HANDLE;
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file)
      throw std::runtime_error("Photo All shader is missing");
    const auto length = file.tellg();
    if (length <= 0 || length % 4 != 0)
      throw std::runtime_error("Invalid Photo All shader");
    std::vector<uint32_t> code(static_cast<size_t>(length) / 4);
    file.seekg(0);
    file.read(reinterpret_cast<char *>(code.data()), length);
    VkShaderModuleCreateInfo shaderInfo{
        VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
    shaderInfo.codeSize = code.size() * 4;
    shaderInfo.pCode = code.data();
    VkShaderModule shader = VK_NULL_HANDLE;
    check(vkCreateShaderModule(device, &shaderInfo, nullptr, &shader),
          "load shader");
    VkComputePipelineCreateInfo compute{
        VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};
    compute.stage = {VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};
    compute.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
    compute.stage.module = shader;
    compute.stage.pName = "main";
    compute.layout = pipelineLayout;
    const auto status = vkCreateComputePipelines(device, VK_NULL_HANDLE, 1,
                                                 &compute, nullptr, &result);
    vkDestroyShaderModule(device, shader, nullptr);
    check(status, "create compute pipeline");
    return result;
  }
  void init(const char *shaderPath) {
    VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};
    app.pApplicationName = "Photo All Film";
    app.apiVersion = VK_API_VERSION_1_1;
    VkInstanceCreateInfo create{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
    create.pApplicationInfo = &app;
    check(vkCreateInstance(&create, nullptr, &instance),
          "create Vulkan instance");
    uint32_t count = 0;
    check(vkEnumeratePhysicalDevices(instance, &count, nullptr),
          "enumerate GPUs");
    std::vector<VkPhysicalDevice> devices(count);
    check(vkEnumeratePhysicalDevices(instance, &count, devices.data()),
          "enumerate GPUs");
    uint64_t best = 0;
    for (auto candidate : devices) {
      VkPhysicalDeviceProperties props;
      VkPhysicalDeviceMemoryProperties memory;
      vkGetPhysicalDeviceProperties(candidate, &props);
      vkGetPhysicalDeviceMemoryProperties(candidate, &memory);
      if (props.deviceType == VK_PHYSICAL_DEVICE_TYPE_CPU)
        continue;
      uint32_t queueCount = 0;
      vkGetPhysicalDeviceQueueFamilyProperties(candidate, &queueCount, nullptr);
      std::vector<VkQueueFamilyProperties> queues(queueCount);
      vkGetPhysicalDeviceQueueFamilyProperties(candidate, &queueCount,
                                               queues.data());
      for (uint32_t q = 0; q < queueCount; q++) {
        if (!(queues[q].queueFlags & VK_QUEUE_COMPUTE_BIT))
          continue;
        uint64_t capacity = 0;
        for (uint32_t h = 0; h < memory.memoryHeapCount; h++)
          if (memory.memoryHeaps[h].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT)
            capacity += memory.memoryHeaps[h].size;
        // Prefer a discrete GPU, then the largest local memory heap.
        uint64_t score =
            capacity + (props.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
                            ? (1ull << 60)
                            : 0);
        if (!physical || score > best) {
          best = score;
          physical = candidate;
          family = q;
          properties = props;
          memoryProperties = memory;
        }
        break;
      }
    }
    if (!physical)
      throw std::runtime_error("No Vulkan GPU with a compute queue");
    float priority = 1;
    VkDeviceQueueCreateInfo queueInfo{
        VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
    queueInfo.queueFamilyIndex = family;
    queueInfo.queueCount = 1;
    queueInfo.pQueuePriorities = &priority;
    VkDeviceCreateInfo deviceInfo{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};
    deviceInfo.queueCreateInfoCount = 1;
    deviceInfo.pQueueCreateInfos = &queueInfo;
    VkPhysicalDeviceFeatures features{};
    vkGetPhysicalDeviceFeatures(physical, &features);
    float64 = features.shaderFloat64;
    VkPhysicalDeviceFeatures enabled{};
    enabled.shaderFloat64 = features.shaderFloat64;
    deviceInfo.pEnabledFeatures = &enabled;
    check(vkCreateDevice(physical, &deviceInfo, nullptr, &device),
          "create GPU device");
    vkGetDeviceQueue(device, family, 0, &queue);
    std::array<VkDescriptorSetLayoutBinding, 3> bindings{};
    for (uint32_t i = 0; i < bindings.size(); i++)
      bindings[i] = {i, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1,
                     VK_SHADER_STAGE_COMPUTE_BIT, nullptr};
    VkDescriptorSetLayoutCreateInfo layout{
        VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
    layout.bindingCount = bindings.size();
    layout.pBindings = bindings.data();
    check(vkCreateDescriptorSetLayout(device, &layout, nullptr,
                                      &descriptorLayout),
          "create bindings");
    VkPushConstantRange push{VK_SHADER_STAGE_COMPUTE_BIT, 0, 64};
    VkPipelineLayoutCreateInfo pipelineInfo{
        VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
    pipelineInfo.setLayoutCount = 1;
    pipelineInfo.pSetLayouts = &descriptorLayout;
    pipelineInfo.pushConstantRangeCount = 1;
    pipelineInfo.pPushConstantRanges = &push;
    check(
        vkCreatePipelineLayout(device, &pipelineInfo, nullptr, &pipelineLayout),
        "create pipeline layout");
    pipeline = loadPipeline(
        std::filesystem::path(reinterpret_cast<const char8_t *>(shaderPath)));
    spatialPath =
        std::filesystem::path(reinterpret_cast<const char8_t *>(shaderPath))
            .parent_path() /
        "spatial.spv";
    VkDescriptorPoolSize poolSize{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 3};
    VkDescriptorPoolCreateInfo pool{
        VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
    pool.maxSets = 1;
    pool.poolSizeCount = 1;
    pool.pPoolSizes = &poolSize;
    check(vkCreateDescriptorPool(device, &pool, nullptr, &descriptorPool),
          "create descriptor pool");
    VkDescriptorSetAllocateInfo set{
        VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
    set.descriptorPool = descriptorPool;
    set.descriptorSetCount = 1;
    set.pSetLayouts = &descriptorLayout;
    check(vkAllocateDescriptorSets(device, &set, &descriptor),
          "allocate descriptor");
    VkCommandPoolCreateInfo commands{
        VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
    commands.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    commands.queueFamilyIndex = family;
    check(vkCreateCommandPool(device, &commands, nullptr, &commandPool),
          "create commands");
    VkCommandBufferAllocateInfo allocate{
        VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
    allocate.commandPool = commandPool;
    allocate.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    allocate.commandBufferCount = 1;
    check(vkAllocateCommandBuffers(device, &allocate, &command),
          "allocate commands");
    VkFenceCreateInfo fenceInfo{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    check(vkCreateFence(device, &fenceInfo, nullptr, &fence), "create fence");
  }
  int blur(const float *input, float *output, uint32_t width, uint32_t height,
           const double *coefficients, uint32_t coefficientCount,
           uint32_t recursive) {
    const VkDeviceSize bytes = size_t(width) * height * 4;
    uint64_t memory = 0;
    for (uint32_t i = 0; i < memoryProperties.memoryHeapCount; i++)
      if (memoryProperties.memoryHeaps[i].flags &
          VK_MEMORY_HEAP_DEVICE_LOCAL_BIT)
        memory += memoryProperties.memoryHeaps[i].size;
    // A refused spatial allocation keeps the pointwise GPU path available.
    if (!float64 || !width || !height || !input || !output ||
        !coefficientCount || bytes > properties.limits.maxStorageBufferRange ||
        bytes * 4 > std::min(768ull * 1024 * 1024, memory / 16))
      return 1;
    if (!spatialPipeline)
      spatialPipeline = loadPipeline(spatialPath);
    reserve(buffers[0], bytes, true, true);
    reserve(buffers[1], bytes, true, true);
    reserve(buffers[2], coefficientCount * 8, true);
    reserve(staging[0], bytes);
    reserve(staging[1], bytes, false, false, true);
    std::memcpy(staging[0].mapped, input, bytes);
    std::memcpy(buffers[2].mapped, coefficients, coefficientCount * 8);
    std::array<VkDescriptorBufferInfo, 3> infos{};
    std::array<VkWriteDescriptorSet, 3> writes{};
    for (uint32_t i = 0; i < 3; i++) {
      infos[i] = {buffers[i].handle, 0, i == 2 ? coefficientCount * 8 : bytes};
      writes[i] = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
      writes[i].dstSet = descriptor;
      writes[i].dstBinding = i;
      writes[i].descriptorCount = 1;
      writes[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
      writes[i].pBufferInfo = &infos[i];
    }
    vkUpdateDescriptorSets(device, 3, writes.data(), 0, nullptr);
    check(vkResetCommandBuffer(command, 0), "reset spatial command");
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    check(vkBeginCommandBuffer(command, &begin), "begin spatial compute");
    VkBufferCopy transfer{0, 0, bytes};
    vkCmdCopyBuffer(command, staging[0].handle, buffers[0].handle, 1,
                    &transfer);
    VkMemoryBarrier barrier{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
    vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_TRANSFER_BIT,
                         VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &barrier,
                         0, nullptr, 0, nullptr);
    vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, spatialPipeline);
    vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE,
                            pipelineLayout, 0, 1, &descriptor, 0, nullptr);
    std::array<uint32_t, 16> parameters{width, height, recursive, 0,
                                        (coefficientCount - 1) / 2};
    for (uint32_t pass = 0; pass < 2; pass++) {
      parameters[3] = pass;
      const uint32_t jobs =
          recursive ? (pass == 0 ? height : width) : width * height;
      const uint32_t groups = (jobs + 127) / 128, x = std::min(groups, 65535u);
      vkCmdPushConstants(command, pipelineLayout, VK_SHADER_STAGE_COMPUTE_BIT,
                         0, 64, parameters.data());
      vkCmdDispatch(command, x, (groups + x - 1) / x, 1);
      barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
      barrier.dstAccessMask =
          VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT;
      vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                           VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &barrier,
                           0, nullptr, 0, nullptr);
    }
    barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
    vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                         VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 1, &barrier, 0,
                         nullptr, 0, nullptr);
    vkCmdCopyBuffer(command, buffers[0].handle, staging[1].handle, 1,
                    &transfer);
    barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_HOST_READ_BIT;
    vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_TRANSFER_BIT,
                         VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &barrier, 0, nullptr,
                         0, nullptr);
    check(vkEndCommandBuffer(command), "end spatial compute");
    check(vkResetFences(device, 1, &fence), "reset spatial fence");
    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    submit.commandBufferCount = 1;
    submit.pCommandBuffers = &command;
    check(vkQueueSubmit(queue, 1, &submit, fence), "submit spatial compute");
    check(vkWaitForFences(device, 1, &fence, VK_TRUE, 30'000'000'000ull),
          "wait spatial compute");
    std::memcpy(output, staging[1].mapped, bytes);
    return 0;
  }
  void run(const float *input, float *output, uint32_t count,
           const float *table, size_t tableCount, uint64_t token,
           const uint32_t *parameters) {
    auto now = [] { return std::chrono::steady_clock::now(); };
    auto before = now();
    auto mark = [&](size_t index) {
      auto after = now();
      timings[index] = std::chrono::duration<double>(after - before).count();
      before = after;
    };
    if (!input || !output || !table || !count || count > 2097152 || !tableCount)
      throw std::runtime_error("Invalid GPU request");
    reserve(buffers[0], size_t(count) * 12, true, true);
    reserve(buffers[1], size_t(count) * 12, true, true);
    reserve(staging[0], size_t(count) * 12);
    reserve(staging[1], size_t(count) * 12, false, false, true);
    std::memcpy(staging[0].mapped, input, size_t(count) * 12);
    mark(0);
    auto found =
        std::find_if(tables.begin(), tables.end(),
                     [token](const auto &item) { return item.first == token; });
    if (found == tables.end()) {
      auto bytes = [this]() {
        VkDeviceSize sum = 0;
        for (const auto &item : tables)
          sum += item.second.capacity;
        return sum;
      };
      while (!tables.empty() &&
             (tables.size() >= 4 ||
              bytes() + tableCount * 4 > 96ull * 1024 * 1024)) {
        releaseBuffer(tables.front().second);
        tables.erase(tables.begin());
      }
      tables.emplace_back(token, Buffer{});
      found = std::prev(tables.end());
      reserve(found->second, tableCount * 4, true);
      std::memcpy(found->second.mapped, table, tableCount * 4);
    }
    Buffer &tableBuffer = found->second;
    mark(1);
    std::array<VkDescriptorBufferInfo, 3> infos{};
    std::array<VkWriteDescriptorSet, 3> writes{};
    for (uint32_t i = 0; i < 3; i++) {
      infos[i] = {i == 2 ? tableBuffer.handle : buffers[i].handle, 0,
                  i == 2 ? tableCount * 4 : size_t(count) * 12};
      writes[i] = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
      writes[i].dstSet = descriptor;
      writes[i].dstBinding = i;
      writes[i].descriptorCount = 1;
      writes[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
      writes[i].pBufferInfo = &infos[i];
    }
    vkUpdateDescriptorSets(device, writes.size(), writes.data(), 0, nullptr);
    check(vkResetCommandBuffer(command, 0), "reset command");
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    check(vkBeginCommandBuffer(command, &begin), "begin compute");
    VkBufferCopy transfer{0, 0, size_t(count) * 12};
    vkCmdCopyBuffer(command, staging[0].handle, buffers[0].handle, 1,
                    &transfer);
    VkMemoryBarrier upload{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    upload.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    upload.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
    vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_TRANSFER_BIT,
                         VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &upload, 0,
                         nullptr, 0, nullptr);
    vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
    vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE,
                            pipelineLayout, 0, 1, &descriptor, 0, nullptr);
    vkCmdPushConstants(command, pipelineLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0,
                       64, parameters);
    vkCmdDispatch(command, (count + 127) / 128, 1, 1);
    VkMemoryBarrier barrier{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
    vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                         VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 1, &barrier, 0,
                         nullptr, 0, nullptr);
    vkCmdCopyBuffer(command, buffers[1].handle, staging[1].handle, 1,
                    &transfer);
    barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_HOST_READ_BIT;
    vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_TRANSFER_BIT,
                         VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &barrier, 0, nullptr,
                         0, nullptr);
    check(vkEndCommandBuffer(command), "end compute");
    check(vkResetFences(device, 1, &fence), "reset fence");
    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    submit.commandBufferCount = 1;
    submit.pCommandBuffers = &command;
    check(vkQueueSubmit(queue, 1, &submit, fence), "submit compute");
    check(vkWaitForFences(device, 1, &fence, VK_TRUE, 30'000'000'000ull),
          "wait for compute");
    mark(2);
    std::memcpy(output, staging[1].mapped, size_t(count) * 12);
    mark(3);
  }
};
} // namespace
API uint32_t pa_gpu_version() { return 4; }
API int pa_gpu_blur(void *context, const float *input, float *output,
                    uint32_t width, uint32_t height, const double *coefficients,
                    uint32_t count, uint32_t recursive) {
  try {
    return static_cast<Context *>(context)->blur(
        input, output, width, height, coefficients, count, recursive);
  } catch (const std::exception &e) {
    lastError = e.what();
    return -1;
  }
}
API void pa_gpu_timings(void *context, double *timings) {
  std::copy_n(static_cast<Context *>(context)->timings.data(), 4, timings);
}
API void *pa_gpu_create(const char *shader) {
  try {
    auto context = std::make_unique<Context>();
    context->init(shader);
    return context.release();
  } catch (const std::exception &e) {
    lastError = e.what();
    return nullptr;
  }
}
API void pa_gpu_destroy(void *context) {
  delete static_cast<Context *>(context);
}
API const char *pa_gpu_error() { return lastError.c_str(); }
API const char *pa_gpu_device(void *context) {
  return static_cast<Context *>(context)->properties.deviceName;
}
API uint64_t pa_gpu_memory(void *context) {
  uint64_t bytes = 0;
  const auto &memory = static_cast<Context *>(context)->memoryProperties;
  for (uint32_t i = 0; i < memory.memoryHeapCount; i++)
    if (memory.memoryHeaps[i].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT)
      bytes += memory.memoryHeaps[i].size;
  return bytes;
}
API int pa_gpu_run(void *context, const float *input, float *output,
                   uint32_t count, const float *table, size_t tableCount,
                   uint64_t token, const uint32_t *parameters) {
  try {
    static_cast<Context *>(context)->run(input, output, count, table,
                                         tableCount, token, parameters);
    return 0;
  } catch (const std::exception &e) {
    lastError = e.what();
    return -1;
  }
}
