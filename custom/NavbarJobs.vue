<template>
  <div ref="dropdownRef">
    <div class="cursor-pointer hover:scale-110 transition-transform" @click="isDropdownOpen = !isDropdownOpen">
      <div v-if="isAlLeastOneJobRunning" class="relative">
        <div class="loader "></div>
        <div class="absolute -bottom-1 -right-1 rounded-full bg-lightPrimary w-4 h-4 text-xs flex items-center justify-center text-white"> {{ jobsCount }}</div>
      </div>
      <div class="flex items-center justify-center" v-else-if="jobs.length > 0">
        <Tooltip>
          <IconCheckCircleOutline class="w-8 h-8 text-green-500" />
          <template #tooltip>
            {{ t('All jobs completed') }}
          </template>
        </Tooltip>
      </div>
    </div>
    <Transition
      enter-active-class="transition ease-out duration-200"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition ease-in duration-150"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div v-show="isDropdownOpen" class="absolute right-28 top-14 md:top-12 rounded z-10">
        <JobsList 
          :closeDropdown="() => isDropdownOpen = false"
          :jobs="jobs" 
        />
      </div>
    </Transition>
  </div>

  
</template>



<script setup lang="ts">
  import type { AdminUser } from 'adminforth';
  import { onMounted, onUnmounted, ref, computed } from 'vue';
  import { IconCheckCircleOutline } from '@iconify-prerendered/vue-flowbite';
  import { Tooltip, Modal } from '@/afcl';
  import { useI18n } from 'vue-i18n';
  import JobsList from './JobsList.vue';
  import type { IJob } from './utils';
  import { callAdminForthApi } from '@/utils';
  import websocket from '@/websocket';
  import { onClickOutside } from '@vueuse/core'

  const { t } = useI18n();

  const props = defineProps<{
    meta: {
      pluginInstanceId: string;
    };
    adminUser: AdminUser;
  }>();

  const isDropdownOpen = ref(false);
  const jobs = ref<IJob[]>([]);
  const dropdownRef = ref<HTMLElement | null>(null);

  onClickOutside(dropdownRef, () => {
    isDropdownOpen.value = false;
  });

  const isAlLeastOneJobRunning = computed(() => {
    return jobs.value.some(job => job.status === 'IN_PROGRESS');
  })

  const jobsCount = computed(() => {
    return jobs.value.filter(job => job.status === 'IN_PROGRESS').length;
  })



  onMounted(async () => {
    websocket.subscribe('/background-jobs', (data) => {
      const jobIndex = jobs.value.findIndex(job => job.id === data.jobId);
      if (jobIndex !== -1) {
        if (data.status) {
          jobs.value[jobIndex].status = data.status;
        }
        if (data.progress !== undefined) {
          jobs.value[jobIndex].progress = data.progress;
        }
      } else {
        jobs.value.push({
          id: data.jobId,
          name: data.name || 'Unknown Job',
          status: data.status || 'IN_PROGRESS',
          progress: data.progress || 0,
          createdAt: data.createdAt || new Date().toISOString(),
        });
      }
    });


    try {
      const res = await callAdminForthApi({
        path: `/plugin/${props.meta.pluginInstanceId}/get-list-of-jobs`,
        method: 'POST',
      });
      jobs.value = res.jobs;
    } catch (error) {
      console.error('Error fetching jobs:', error);
    }
  });


  onUnmounted(() => {
    websocket.unsubscribe('/background-jobs');
  });

</script>


<style scoped lang="scss">
  .loader {
    width: 28px;
    aspect-ratio: 1;
    border-radius: 50%;
    --spinner-color: #1a56db;

    background:
      conic-gradient(
        from 120deg,
        var(--spinner-color) 0deg 40deg,
        transparent 40deg
      ),

      conic-gradient(#ccc 0deg 360deg);

    -webkit-mask: radial-gradient(
      farthest-side,
      transparent calc(100% - 6px),
      #000 calc(100% - 5px)
    );
    mask: radial-gradient(
      farthest-side,
      transparent calc(100% - 6px),
      #000 calc(100% - 5px)
    );

    animation: stepRotate 2s infinite;
  }

  @keyframes stepRotate {
    to { transform: rotate(1turn); }
  }
</style>